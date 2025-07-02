import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import boxen from 'boxen';
import { z } from 'zod';

import {
	log,
	writeJSON,
	enableSilentMode,
	disableSilentMode,
	isSilentMode,
	readJSON,
	findTaskById,
	ensureTagMetadata,
	getCurrentTag
} from '../utils.js';

import { generateObjectService } from '../ai-services-unified.js';
import { getDebugFlag } from '../config-manager.js';
import generateTaskFiles from './generate-task-files.js';
import { displayAiUsageSummary } from '../ui.js';

// Define the Zod schema for a SINGLE task object
const prdSingleTaskSchema = z.object({
	id: z.number().int().positive(),
	title: z.string().min(1),
	description: z.string().min(1),
	details: z.string().nullable(),
	testStrategy: z.string().nullable(),
	priority: z.enum(['high', 'medium', 'low']).nullable(),
	dependencies: z.array(z.number().int().positive()).nullable(),
	status: z.string().nullable()
});

// Define the Zod schema for the ENTIRE expected AI response object
const prdResponseSchema = z.object({
	tasks: z.array(prdSingleTaskSchema),
	metadata: z.object({
		projectName: z.string(),
		totalTasks: z.number(),
		sourceFile: z.string(),
		generatedAt: z.string()
	})
});

/**
 * Parse a PRD file and generate tasks
 * @param {string} prdPath - Path to the PRD file
 * @param {string} tasksPath - Path to the tasks.json file
 * @param {number} numTasks - Number of tasks to generate
 * @param {Object} options - Additional options
 * @param {boolean} [options.force=false] - Whether to overwrite existing tasks.json.
 * @param {boolean} [options.append=false] - Append to existing tasks file.
 * @param {boolean} [options.research=false] - Use research model for enhanced PRD analysis.
 * @param {Object} [options.reportProgress] - Function to report progress (optional, likely unused).
 * @param {Object} [options.mcpLog] - MCP logger object (optional).
 * @param {Object} [options.session] - Session object from MCP server (optional).
 * @param {string} [options.projectRoot] - Project root path (for MCP/env fallback).
 * @param {string} [options.tag] - Target tag for task generation.
 * @param {string} [outputFormat='text'] - Output format ('text' or 'json').
 */
async function parsePRD(prdPath, tasksPath, numTasks, options = {}) {
	const {
		reportProgress,
		mcpLog,
		session,
		projectRoot,
		force = false,
		append = false,
		research = false,
		tag
	} = options;
	const isMCP = !!mcpLog;
	const outputFormat = isMCP ? 'json' : 'text';

	// Use the provided tag, or the current active tag, or default to 'master'
	const targetTag = tag || getCurrentTag(projectRoot) || 'master';

	const logFn = mcpLog
		? mcpLog
		: {
				// Wrapper for CLI
				info: (...args) => log('info', ...args),
				warn: (...args) => log('warn', ...args),
				error: (...args) => log('error', ...args),
				debug: (...args) => log('debug', ...args),
				success: (...args) => log('success', ...args)
			};

	// Create custom reporter using logFn
	const report = (message, level = 'info') => {
		// Check logFn directly
		if (logFn && typeof logFn[level] === 'function') {
			logFn[level](message);
		} else if (!isSilentMode() && outputFormat === 'text') {
			// Fallback to original log only if necessary and in CLI text mode
			log(level, message);
		}
	};

	report(
		`Разбор файла PRD: ${prdPath}, Принудительно: ${force}, Добавить: ${append}, Исследование: ${research}`
	);

	let existingTasks = [];
	let nextId = 1;
	let aiServiceResponse = null;

	try {
		// Check if there are existing tasks in the target tag
		let hasExistingTasksInTag = false;
		if (fs.existsSync(tasksPath)) {
			try {
				// Read the entire file to check if the tag exists
				const existingFileContent = fs.readFileSync(tasksPath, 'utf8');
				const allData = JSON.parse(existingFileContent);

				// Check if the target tag exists and has tasks
				if (
					allData[targetTag] &&
					Array.isArray(allData[targetTag].tasks) &&
					allData[targetTag].tasks.length > 0
				) {
					hasExistingTasksInTag = true;
					existingTasks = allData[targetTag].tasks;
					nextId = Math.max(...existingTasks.map((t) => t.id || 0)) + 1;
				}
			} catch (error) {
				// If we can't read the file or parse it, assume no existing tasks in this tag
				hasExistingTasksInTag = false;
			}
		}

		// Handle file existence and overwrite/append logic based on target tag
		if (hasExistingTasksInTag) {
			if (append) {
				report(
					`Режим добавления включен. Найдено ${existingTasks.length} существующих задач в теге '${targetTag}'. Следующий ID будет ${nextId}.`,
					'info'
				);
			} else if (!force) {
				// Not appending and not forcing overwrite, and there are existing tasks in the target tag
				const overwriteError = new Error(
					`Тег '${targetTag}' уже содержит ${existingTasks.length} задач. Используйте --force для перезаписи или --append для добавления к существующим задачам.`
				);
				report(overwriteError.message, 'error');
				if (outputFormat === 'text') {
					console.error(chalk.red(overwriteError.message));
					process.exit(1);
				} else {
					throw overwriteError;
				}
			} else {
				// Force overwrite is true
				report(
					`Флаг force включен. Перезапись существующих задач в теге '${targetTag}'.`,
					'info'
				);
			}
		} else {
			// No existing tasks in target tag, proceed without confirmation
			report(
				`Тег '${targetTag}' пуст или не существует. Создание/обновление тега новыми задачами.`,
				'info'
			);
		}

		report(`Чтение содержимого PRD из ${prdPath}`, 'info');
		const prdContent = fs.readFileSync(prdPath, 'utf8');
		if (!prdContent) {
			throw new Error(`Входной файл ${prdPath} пуст или не может быть прочитан.`);
		}

		// Research-specific enhancements to the system prompt
		const researchPromptAddition = research
			? `\nПеред разбивкой PRD на задачи вы должны:
1. Исследовать и проанализировать последние технологии, библиотеки, фреймворки и лучшие практики, которые подходят для этого проекта
2. Выявить любые потенциальные технические проблемы, проблемы безопасности или масштабируемости, не упомянутые явно в PRD, не отбрасывая при этом явные требования и не переусложняя -- всегда стремитесь обеспечить наиболее прямой путь к реализации, избегая избыточного проектирования или окольных подходов
3. Рассмотреть текущие отраслевые стандарты и развивающиеся тенденции, релевантные для этого проекта (этот шаг направлен на решение галлюцинаций LLM и устаревшей информации из-за даты обрезания обучающих данных)
4. Оценить альтернативные подходы к реализации и рекомендовать наиболее эффективный путь
5. Включить конкретные версии библиотек, полезные API и конкретное руководство по реализации на основе вашего исследования
6. Всегда стремиться обеспечить наиболее прямой путь к реализации, избегая избыточного проектирования или окольных подходов

Ваша разбивка задач должна включать это исследование, что приведет к более детальному руководству по реализации, более точному сопоставлению зависимостей и более точным технологическим рекомендациям, чем это было бы возможно только на основе текста PRD, сохраняя при этом все явные требования и лучшие практики и все детали и нюансы PRD.`
			: '';

		// Base system prompt for PRD parsing
		const systemPrompt = `Вы — AI-ассистент, специализирующийся на анализе документов с требованиями к продукту (PRD) и генерации структурированного, логически упорядоченного, учитывающего зависимости и последовательного списка задач разработки в формате JSON.${researchPromptAddition}

Проанализируйте предоставленное содержимое PRD и сгенерируйте примерно ${numTasks} задач верхнего уровня. Если сложность или уровень детализации PRD высоки, сгенерируйте больше задач относительно сложности PRD
Каждая задача должна представлять собой логическую единицу работы, необходимую для реализации требований, и сосредоточиться на наиболее прямом и эффективном способе реализации требований без излишней сложности или избыточного проектирования. Включите псевдокод, детали реализации и стратегию тестирования для каждой задачи. Найдите самую актуальную информацию для реализации каждой задачи.
Назначьте последовательные ID, начиная с ${nextId}. Выведите заголовок, описание, детали и стратегию тестирования для каждой задачи, основываясь *только* на содержимом PRD.
Установите статус 'pending', зависимости в пустой массив [], и приоритет 'medium' изначально для всех задач.
Отвечайте ТОЛЬКО валидным объектом JSON, содержащим один ключ "tasks", где значением является массив объектов задач, соответствующих предоставленной схеме Zod. Не включайте никаких объяснений или форматирования markdown.

Каждая задача должна соответствовать следующей структуре JSON:
{
	"id": number,
	"title": string,
	"description": string,
	"status": "pending",
	"dependencies": number[],
	"priority": "high" | "medium" | "low",
	"details": string (implementation details),
	"testStrategy": string (validation approach)
}

Рекомендации:
1. Если сложность не требует иного, создайте ровно ${numTasks} задач, пронумерованных последовательно, начиная с ${nextId}
2. Каждая задача должна быть атомарной и сосредоточенной на одной обязанности, следуя самым актуальным лучшим практикам и стандартам
3. Упорядочивайте задачи логически — учитывайте зависимости и последовательность реализации
4. Ранние задачи должны быть сосредоточены на настройке, основной функциональности, затем на расширенных функциях
5. Включите четкий подход к проверке/тестированию для каждой задачи
6. Установите соответствующие ID зависимостей (задача может зависеть только от задач с меньшими ID, потенциально включая существующие задачи с ID меньше ${nextId}, если применимо)
7. Назначьте приоритет (высокий/средний/низкий) на основе критичности и порядка зависимостей
8. Включите подробное руководство по реализации в поле "details"${research ? ', с конкретными библиотеками и рекомендациями по версиям на основе вашего исследования' : ''}
9. Если PRD содержит конкретные требования к библиотекам, схемам баз данных, фреймворкам, технологическим стекам или любым другим деталям реализации, СТРОГО ПРИДЕРЖИВАЙТЕСЬ этих требований в вашей разбивке задач и ни при каких обстоятельствах не отбрасывайте их
10. Сосредоточьтесь на заполнении любых пробелов, оставленных PRD, или областей, которые не полностью специфицированы, сохраняя при этом все явные требования
11. Всегда стремитесь предоставить наиболее прямой путь к реализации, избегая избыточного проектирования или окольных подходов${research ? '\n12. Для каждой задачи включите конкретное, действенное руководство, основанное на текущих отраслевых стандартах и лучших практиках, обнаруженных в ходе исследования' : ''}`;

		// Build user prompt with PRD content
		const userPrompt = `Вот документ с требованиями к продукту (PRD), который нужно разбить примерно на ${numTasks} задач, начиная с ID ${nextId}:${research ? '\n\nНе забудьте тщательно изучить текущие лучшие практики и технологии перед разбивкой задач, чтобы предоставить конкретные, действенные детали реализации.' : ''}\n\n${prdContent}\n\n
		Верните ответ в этом формате:
{
    "tasks": [
        {
            "id": 1,
            "title": "Setup Project Repository",
            "description": "...",
            ...
        },
        ...
    ],
    "metadata": {
        "projectName": "PRD Implementation",
        "totalTasks": ${numTasks},
        "sourceFile": "${prdPath}",
        "generatedAt": "YYYY-MM-DD"
    }
}`;

		// Call the unified AI service
		report(
			`Вызов AI-сервиса для генерации задач из PRD${research ? ' с анализом на основе исследований' : ''}...`,
			'info'
		);

		// Call generateObjectService with the CORRECT schema and additional telemetry params
		aiServiceResponse = await generateObjectService({
			role: research ? 'research' : 'main', // Use research role if flag is set
			session: session,
			projectRoot: projectRoot,
			schema: prdResponseSchema,
			objectName: 'tasks_data',
			systemPrompt: systemPrompt,
			prompt: userPrompt,
			commandName: 'parse-prd',
			outputType: isMCP ? 'mcp' : 'cli'
		});

		// Create the directory if it doesn't exist
		const tasksDir = path.dirname(tasksPath);
		if (!fs.existsSync(tasksDir)) {
			fs.mkdirSync(tasksDir, { recursive: true });
		}
		logFn.success(
			`PRD успешно разобран с помощью AI-сервиса${research ? ' с анализом на основе исследований' : ''}.`
		);

		// Validate and Process Tasks
		// const generatedData = aiServiceResponse?.mainResult?.object;

		// Robustly get the actual AI-generated object
		let generatedData = null;
		if (aiServiceResponse?.mainResult) {
			if (
				typeof aiServiceResponse.mainResult === 'object' &&
				aiServiceResponse.mainResult !== null &&
				'tasks' in aiServiceResponse.mainResult
			) {
				// If mainResult itself is the object with a 'tasks' property
				generatedData = aiServiceResponse.mainResult;
			} else if (
				typeof aiServiceResponse.mainResult.object === 'object' &&
				aiServiceResponse.mainResult.object !== null &&
				'tasks' in aiServiceResponse.mainResult.object
			) {
				// If mainResult.object is the object with a 'tasks' property
				generatedData = aiServiceResponse.mainResult.object;
			}
		}

		if (!generatedData || !Array.isArray(generatedData.tasks)) {
			logFn.error(
				`Внутренняя ошибка: generateObjectService вернул неожиданную структуру данных: ${JSON.stringify(generatedData)}`
			);
			throw new Error(
				'AI-сервис вернул неожиданную структуру данных после валидации.'
			);
		}

		let currentId = nextId;
		const taskMap = new Map();
		const processedNewTasks = generatedData.tasks.map((task) => {
			const newId = currentId++;
			taskMap.set(task.id, newId);
			return {
				...task,
				id: newId,
				status: 'pending',
				priority: task.priority || 'medium',
				dependencies: Array.isArray(task.dependencies) ? task.dependencies : [],
				subtasks: []
			};
		});

		// Remap dependencies for the NEWLY processed tasks
		processedNewTasks.forEach((task) => {
			task.dependencies = task.dependencies
				.map((depId) => taskMap.get(depId)) // Map old AI ID to new sequential ID
				.filter(
					(newDepId) =>
						newDepId != null && // Must exist
						newDepId < task.id && // Must be a lower ID (could be existing or newly generated)
						(findTaskById(existingTasks, newDepId) || // Check if it exists in old tasks OR
							processedNewTasks.some((t) => t.id === newDepId)) // check if it exists in new tasks
				);
		});

		const finalTasks = append
			? [...existingTasks, ...processedNewTasks]
			: processedNewTasks;

		// Read the existing file to preserve other tags
		let outputData = {};
		if (fs.existsSync(tasksPath)) {
			try {
				const existingFileContent = fs.readFileSync(tasksPath, 'utf8');
				outputData = JSON.parse(existingFileContent);
			} catch (error) {
				// If we can't read the existing file, start with empty object
				outputData = {};
			}
		}

		// Update only the target tag, preserving other tags
		outputData[targetTag] = {
			tasks: finalTasks,
			metadata: {
				created:
					outputData[targetTag]?.metadata?.created || new Date().toISOString(),
				updated: new Date().toISOString(),
				description: `Tasks for ${targetTag} context`
			}
		};

		// Ensure the target tag has proper metadata
		ensureTagMetadata(outputData[targetTag], {
			description: `Tasks for ${targetTag} context`
		});

		// Write the complete data structure back to the file
		fs.writeFileSync(tasksPath, JSON.stringify(outputData, null, 2));
		report(
			`Успешно ${append ? 'добавлено' : 'сгенерировано'} ${processedNewTasks.length} задач в ${tasksPath}${research ? ' с анализом на основе исследований' : ''}`,
			'success'
		);

		// Generate markdown task files after writing tasks.json
		// await generateTaskFiles(tasksPath, path.dirname(tasksPath), { mcpLog });

		// Handle CLI output (e.g., success message)
		if (outputFormat === 'text') {
			console.log(
				boxen(
					chalk.green(
						`Успешно сгенерировано ${processedNewTasks.length} новых задач${research ? ' с анализом на основе исследований' : ''}. Всего задач в ${tasksPath}: ${finalTasks.length}`
					),
					{ padding: 1, borderColor: 'green', borderStyle: 'round' }
				)
			);

			console.log(
				boxen(
					chalk.white.bold('Следующие шаги:') +
						'\n\n' +
						`${chalk.cyan('1.')} Выполните ${chalk.yellow('task-master list')}, чтобы просмотреть все задачи\n` +
						`${chalk.cyan('2.')} Выполните ${chalk.yellow('task-master expand --id=<id>')}, чтобы разбить задачу на подзадачи`,
					{
						padding: 1,
						borderColor: 'cyan',
						borderStyle: 'round',
						margin: { top: 1 }
					}
				)
			);

			if (aiServiceResponse && aiServiceResponse.telemetryData) {
				displayAiUsageSummary(aiServiceResponse.telemetryData, 'cli');
			}
		}

		// Return telemetry data
		return {
			success: true,
			tasksPath,
			telemetryData: aiServiceResponse?.telemetryData,
			tagInfo: aiServiceResponse?.tagInfo
		};
	} catch (error) {
		report(`Ошибка разбора PRD: ${error.message}`, 'error');

		// Only show error UI for text output (CLI)
		if (outputFormat === 'text') {
			console.error(chalk.red(`Ошибка: ${error.message}`));

			if (getDebugFlag(projectRoot)) {
				// Use projectRoot for debug flag check
				console.error(error);
			}

			process.exit(1);
		} else {
			throw error; // Re-throw for JSON output
		}
	}
}

export default parsePRD;
