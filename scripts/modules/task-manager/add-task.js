import path from 'path';
import chalk from 'chalk';
import boxen from 'boxen';
import Table from 'cli-table3';
import { z } from 'zod';
import Fuse from 'fuse.js'; // Import Fuse.js for advanced fuzzy search

import {
	displayBanner,
	getStatusWithColor,
	startLoadingIndicator,
	stopLoadingIndicator,
	succeedLoadingIndicator,
	failLoadingIndicator,
	displayAiUsageSummary,
	displayContextAnalysis
} from '../ui.js';
import {
	readJSON,
	writeJSON,
	log as consoleLog,
	truncate,
	ensureTagMetadata,
	performCompleteTagMigration,
	markMigrationForNotice,
	getCurrentTag
} from '../utils.js';
import { generateObjectService } from '../ai-services-unified.js';
import { getDefaultPriority } from '../config-manager.js';
import ContextGatherer from '../utils/contextGatherer.js';

// Define Zod schema for the expected AI output object
const AiTaskDataSchema = z.object({
	title: z.string().describe('Четкий, краткий заголовок для задачи'),
	description: z
		.string()
		.describe('Описание задачи в одном или двух предложениях'),
	details: z
		.string()
		.describe('Подробные детали реализации, соображения и руководство'),
	testStrategy: z
		.string()
		.describe('Подробный подход для проверки выполнения задачи'),
	dependencies: z
		.array(z.number())
		.nullable()
		.describe(
			'Массив идентификаторов задач, от которых зависит эта задача (должны быть выполнены до начала этой задачи)'
		)
});

/**
 * Get all tasks from all tags
 * @param {Object} rawData - The raw tagged data object
 * @returns {Array} A flat array of all task objects
 */
function getAllTasks(rawData) {
	let allTasks = [];
	for (const tagName in rawData) {
		if (
			Object.prototype.hasOwnProperty.call(rawData, tagName) &&
			rawData[tagName] &&
			Array.isArray(rawData[tagName].tasks)
		) {
			allTasks = allTasks.concat(rawData[tagName].tasks);
		}
	}
	return allTasks;
}

/**
 * Add a new task using AI
 * @param {string} tasksPath - Path to the tasks.json file
 * @param {string} prompt - Description of the task to add (required for AI-driven creation)
 * @param {Array} dependencies - Task dependencies
 * @param {string} priority - Task priority
 * @param {function} reportProgress - Function to report progress to MCP server (optional)
 * @param {Object} mcpLog - MCP logger object (optional)
 * @param {Object} session - Session object from MCP server (optional)
 * @param {string} outputFormat - Output format (text or json)
 * @param {Object} customEnv - Custom environment variables (optional) - Note: AI params override deprecated
 * @param {Object} manualTaskData - Manual task data (optional, for direct task creation without AI)
 * @param {boolean} useResearch - Whether to use the research model (passed to unified service)
 * @param {Object} context - Context object containing session and potentially projectRoot
 * @param {string} [context.projectRoot] - Project root path (for MCP/env fallback)
 * @param {string} [context.commandName] - The name of the command being executed (for telemetry)
 * @param {string} [context.outputType] - The output type ('cli' or 'mcp', for telemetry)
 * @param {string} [tag] - Tag for the task (optional)
 * @returns {Promise<object>} An object containing newTaskId and telemetryData
 */
async function addTask(
	tasksPath,
	prompt,
	dependencies = [],
	priority = null,
	context = {},
	outputFormat = 'text', // Default to text for CLI
	manualTaskData = null,
	useResearch = false,
	tag = null
) {
	const { session, mcpLog, projectRoot, commandName, outputType } = context;
	const isMCP = !!mcpLog;

	// Create a consistent logFn object regardless of context
	const logFn = isMCP
		? mcpLog // Use MCP logger if provided
		: {
				// Create a wrapper around consoleLog for CLI
				info: (...args) => consoleLog('info', ...args),
				warn: (...args) => consoleLog('warn', ...args),
				error: (...args) => consoleLog('error', ...args),
				debug: (...args) => consoleLog('debug', ...args),
				success: (...args) => consoleLog('success', ...args)
			};

	const effectivePriority = priority || getDefaultPriority(projectRoot);

	logFn.info(
		`Добавление новой задачи с промптом: "${prompt}", Приоритет: ${effectivePriority}, Зависимости: ${dependencies.join(', ') || 'Нет'}, Исследование: ${useResearch}, ProjectRoot: ${projectRoot}`
	);
	if (tag) {
		logFn.info(`Использование контекста тега: ${tag}`);
	}

	let loadingIndicator = null;
	let aiServiceResponse = null; // To store the full response from AI service

	// Create custom reporter that checks for MCP log
	const report = (message, level = 'info') => {
		if (mcpLog) {
			mcpLog[level](message);
		} else if (outputFormat === 'text') {
			consoleLog(level, message);
		}
	};

	/**
	 * Recursively builds a dependency graph for a given task
	 * @param {Array} tasks - All tasks from tasks.json
	 * @param {number} taskId - ID of the task to analyze
	 * @param {Set} visited - Set of already visited task IDs
	 * @param {Map} depthMap - Map of task ID to its depth in the graph
	 * @param {number} depth - Current depth in the recursion
	 * @return {Object} Dependency graph data
	 */
	function buildDependencyGraph(
		tasks,
		taskId,
		visited = new Set(),
		depthMap = new Map(),
		depth = 0
	) {
		// Skip if we've already visited this task or it doesn't exist
		if (visited.has(taskId)) {
			return null;
		}

		// Find the task
		const task = tasks.find((t) => t.id === taskId);
		if (!task) {
			return null;
		}

		// Mark as visited
		visited.add(taskId);

		// Update depth if this is a deeper path to this task
		if (!depthMap.has(taskId) || depth < depthMap.get(taskId)) {
			depthMap.set(taskId, depth);
		}

		// Process dependencies
		const dependencyData = [];
		if (task.dependencies && task.dependencies.length > 0) {
			for (const depId of task.dependencies) {
				const depData = buildDependencyGraph(
					tasks,
					depId,
					visited,
					depthMap,
					depth + 1
				);
				if (depData) {
					dependencyData.push(depData);
				}
			}
		}

		return {
			id: task.id,
			title: task.title,
			description: task.description,
			status: task.status,
			dependencies: dependencyData
		};
	}

	try {
		// Read the existing tasks - IMPORTANT: Read the raw data without tag resolution
		let rawData = readJSON(tasksPath, projectRoot); // No tag parameter

		// Handle the case where readJSON returns resolved data with _rawTaggedData
		if (rawData && rawData._rawTaggedData) {
			// Use the raw tagged data and discard the resolved view
			rawData = rawData._rawTaggedData;
		}

		// If file doesn't exist or is invalid, create a new structure in memory
		if (!rawData) {
			report(
				'Файл tasks.json не найден или недействителен. Инициализация новой структуры.',
				'info'
			);
			rawData = {
				master: {
					tasks: [],
					metadata: {
						created: new Date().toISOString(),
						description: 'Контекст задач по умолчанию'
					}
				}
			};
			// Do not write the file here; it will be written later with the new task.
		}

		// Handle legacy format migration using utilities
		if (rawData && Array.isArray(rawData.tasks) && !rawData._rawTaggedData) {
			report('Обнаружен устаревший формат. Выполняется миграция в формат с тегами...', 'info');

			// This is legacy format - migrate it to tagged format
			rawData = {
				master: {
					tasks: rawData.tasks,
					metadata: rawData.metadata || {
						created: new Date().toISOString(),
						updated: new Date().toISOString(),
						description: 'Задачи для основного контекста'
					}
				}
			};
			// Ensure proper metadata using utility
			ensureTagMetadata(rawData.master, {
				description: 'Задачи для основного контекста'
			});
			// Do not write the file here; it will be written later with the new task.

			// Perform complete migration (config.json, state.json)
			performCompleteTagMigration(tasksPath);
			markMigrationForNotice(tasksPath);

			report('Успешно перенесено в формат с тегами.', 'success');
		}

		// Use the provided tag, or the current active tag, or default to 'master'
		const targetTag =
			tag || context.tag || getCurrentTag(projectRoot) || 'master';

		// Ensure the target tag exists
		if (!rawData[targetTag]) {
			report(
				`Тег "${targetTag}" не существует. Пожалуйста, сначала создайте его с помощью команды 'add-tag'.`,
				'error'
			);
			throw new Error(`Тег "${targetTag}" не найден.`);
		}

		// Ensure the target tag has a tasks array and metadata object
		if (!rawData[targetTag].tasks) {
			rawData[targetTag].tasks = [];
		}
		if (!rawData[targetTag].metadata) {
			rawData[targetTag].metadata = {
				created: new Date().toISOString(),
				updated: new Date().toISOString(),
				description: ``
			};
		}

		// Get a flat list of ALL tasks across ALL tags to validate dependencies
		const allTasks = getAllTasks(rawData);

		// Find the highest task ID *within the target tag* to determine the next ID
		const tasksInTargetTag = rawData[targetTag].tasks;
		const highestId =
			tasksInTargetTag.length > 0
				? Math.max(...tasksInTargetTag.map((t) => t.id))
				: 0;
		const newTaskId = highestId + 1;

		// Only show UI box for CLI mode
		if (outputFormat === 'text') {
			console.log(
				boxen(chalk.white.bold(`Создание новой задачи #${newTaskId}`), {
					padding: 1,
					borderColor: 'blue',
					borderStyle: 'round',
					margin: { top: 1, bottom: 1 }
				})
			);
		}

		// Validate dependencies before proceeding
		const invalidDeps = dependencies.filter((depId) => {
			// Ensure depId is parsed as a number for comparison
			const numDepId = parseInt(depId, 10);
			return Number.isNaN(numDepId) || !allTasks.some((t) => t.id === numDepId);
		});

		if (invalidDeps.length > 0) {
			report(
				`Следующие зависимости не существуют или недействительны: ${invalidDeps.join(', ')}`,
				'warn'
			);
			report('Удаление недействительных зависимостей...', 'info');
			dependencies = dependencies.filter(
				(depId) => !invalidDeps.includes(depId)
			);
		}
		// Ensure dependencies are numbers
		const numericDependencies = dependencies.map((dep) => parseInt(dep, 10));

		// Build dependency graphs for explicitly specified dependencies
		const dependencyGraphs = [];
		const allRelatedTaskIds = new Set();
		const depthMap = new Map();

		// First pass: build a complete dependency graph for each specified dependency
		for (const depId of numericDependencies) {
			const graph = buildDependencyGraph(allTasks, depId, new Set(), depthMap);
			if (graph) {
				dependencyGraphs.push(graph);
			}
		}

		// Second pass: build a set of all related task IDs for flat analysis
		for (const [taskId, depth] of depthMap.entries()) {
			allRelatedTaskIds.add(taskId);
		}

		let taskData;

		// Check if manual task data is provided
		if (manualTaskData) {
			report('Использование предоставленных вручную данных задачи', 'info');
			taskData = manualTaskData;
			report('DEBUG: Выбран путь с РУЧНЫМИ данными задачи.', 'debug');

			// Basic validation for manual data
			if (
				!taskData.title ||
				typeof taskData.title !== 'string' ||
				!taskData.description ||
				typeof taskData.description !== 'string'
			) {
				throw new Error(
					'Данные задачи, введенные вручную, должны содержать как минимум заголовок и описание.'
				);
			}
		} else {
			report('DEBUG: Выбран путь генерации задачи с помощью AI.', 'debug');
			// --- Refactored AI Interaction ---
			report(`Генерация данных задачи с помощью AI с промптом:\n${prompt}`, 'info');

			// --- Use the new ContextGatherer ---
			const contextGatherer = new ContextGatherer(projectRoot);
			const gatherResult = await contextGatherer.gather({
				semanticQuery: prompt,
				dependencyTasks: numericDependencies,
				format: 'research'
			});

			const gatheredContext = gatherResult.context;
			const analysisData = gatherResult.analysisData;

			// Display context analysis if not in silent mode
			if (outputFormat === 'text' && analysisData) {
				displayContextAnalysis(analysisData, prompt, gatheredContext.length);
			}

			// System Prompt - Enhanced for dependency awareness
			const systemPrompt =
				"Вы — полезный ассистент, который создает хорошо структурированные задачи для проекта по разработке программного обеспечения. Создайте одну новую задачу на основе описания пользователя, строго придерживаясь предоставленной схемы JSON. Обратите особое внимание на зависимости между задачами, убедившись, что новая задача правильно ссылается на все задачи, от которых она зависит.\n\n" +
				'При определении зависимостей для новой задачи следуйте этим принципам:\n' +
				'1. Выбирайте зависимости на основе логических требований — что должно быть завершено до того, как эта задача может начаться.\n' +
				'2. Отдавайте предпочтение зависимостям задач, которые семантически связаны с создаваемой функциональностью.\n' +
				'3. Учитывайте как прямые зависимости (непосредственно предшествующие), так и косвенные зависимости.\n' +
				'4. Избегайте добавления ненужных зависимостей — включайте только те задачи, которые действительно являются предварительными условиями.\n' +
				'5. Учитывайте текущий статус задач — по возможности предпочитайте завершенные задачи в качестве зависимостей.\n' +
				"6. Обратите особое внимание на основополагающие задачи (1-5), но не включайте их автоматически без причины.\n" +
				'7. Недавние задачи (с более высокими номерами ID) могут быть более релевантными для новой функциональности.\n\n' +
				'Массив зависимостей должен содержать идентификаторы задач (числа) предварительных задач.\n';

			// Task Structure Description (for user prompt)
			const taskStructureDesc = `
      {
        "title": "Заголовок задачи идет здесь",
        "description": "Краткое описание задачи в одном или двух предложениях",
    "details": "Подробные шаги реализации, соображения, примеры кода или технический подход",
    "testStrategy": "Конкретные шаги для проверки правильности реализации и функциональности",
    "dependencies": [1, 3] // Пример: идентификаторы задач, которые должны быть выполнены до этой задачи
  }
`;

			// Add any manually provided details to the prompt for context
			let contextFromArgs = '';
			if (manualTaskData?.title)
				contextFromArgs += `\n- Предлагаемый заголовок: "${manualTaskData.title}"`;
			if (manualTaskData?.description)
				contextFromArgs += `\n- Предлагаемое описание: "${manualTaskData.description}"`;
			if (manualTaskData?.details)
				contextFromArgs += `\n- Дополнительный контекст деталей: "${manualTaskData.details}"`;
			if (manualTaskData?.testStrategy)
				contextFromArgs += `\n- Дополнительный контекст стратегии тестирования: "${manualTaskData.testStrategy}"`;

			// User Prompt
			const userPrompt = `Вы генерируете детали для Задачи #${newTaskId}. На основе запроса пользователя: "${prompt}", создайте комплексную новую задачу для проекта по разработке программного обеспечения.
      
      ${gatheredContext}
      
      На основе информации о существующих задачах, предоставленной выше, включите соответствующие зависимости в массив "dependencies". Включайте только идентификаторы задач, от которых эта новая задача напрямую зависит.
      
      Верните свой ответ в виде одного объекта JSON, точно соответствующего схеме:
      ${taskStructureDesc}
      
      Убедитесь, что детали и стратегия тестирования являются исчерпывающими и конкретными. НЕ включайте идентификатор задачи в заголовок.
      `;

			// Start the loading indicator - only for text mode
			if (outputFormat === 'text') {
				loadingIndicator = startLoadingIndicator(
					`Генерация новой задачи с помощью ${useResearch ? 'Исследовательского' : 'Основного'} AI... \n`
				);
			}

			try {
				const serviceRole = useResearch ? 'research' : 'main';
				report('DEBUG: Вызов generateObjectService...', 'debug');

				aiServiceResponse = await generateObjectService({
					// Capture the full response
					role: serviceRole,
					session: session,
					projectRoot: projectRoot,
					schema: AiTaskDataSchema,
					objectName: 'newTaskData',
					systemPrompt: systemPrompt,
					prompt: userPrompt,
					commandName: commandName || 'add-task', // Use passed commandName or default
					outputType: outputType || (isMCP ? 'mcp' : 'cli') // Use passed outputType or derive
				});
				report('DEBUG: generateObjectService успешно вернулся.', 'debug');

				if (!aiServiceResponse || !aiServiceResponse.mainResult) {
					throw new Error(
						'Сервис AI не вернул ожидаемую структуру объекта.'
					);
				}

				// Prefer mainResult if it looks like a valid task object, otherwise try mainResult.object
				if (
					aiServiceResponse.mainResult.title &&
					aiServiceResponse.mainResult.description
				) {
					taskData = aiServiceResponse.mainResult;
				} else if (
					aiServiceResponse.mainResult.object &&
					aiServiceResponse.mainResult.object.title &&
					aiServiceResponse.mainResult.object.description
				) {
					taskData = aiServiceResponse.mainResult.object;
				} else {
					throw new Error('Сервис AI не вернул действительный объект задачи.');
				}

				report('Успешно сгенерированы данные задачи от AI.', 'success');

				// Success! Show checkmark
				if (loadingIndicator) {
					succeedLoadingIndicator(
						loadingIndicator,
						'Задача успешно сгенерирована'
					);
					loadingIndicator = null; // Clear it
				}
			} catch (error) {
				// Failure! Show X
				if (loadingIndicator) {
					failLoadingIndicator(loadingIndicator, 'Ошибка генерации AI');
					loadingIndicator = null;
				}
				report(
					`DEBUG: generateObjectService перехватил ошибку: ${error.message}`,
					'debug'
				);
				report(`Ошибка при генерации задачи с помощью AI: ${error.message}`, 'error');
				throw error; // Re-throw error after logging
			} finally {
				report('DEBUG: Блок finally в generateObjectService достигнут.', 'debug');
				// Clean up if somehow still running
				if (loadingIndicator) {
					stopLoadingIndicator(loadingIndicator);
				}
			}
			// --- End Refactored AI Interaction ---
		}

		// Create the new task object
		const newTask = {
			id: newTaskId,
			title: taskData.title,
			description: taskData.description,
			details: taskData.details || '',
			testStrategy: taskData.testStrategy || '',
			status: 'pending',
			dependencies: taskData.dependencies?.length
				? taskData.dependencies
				: numericDependencies, // Use AI-suggested dependencies if available, fallback to manually specified
			priority: effectivePriority,
			subtasks: [] // Initialize with empty subtasks array
		};

		// Additional check: validate all dependencies in the AI response
		if (taskData.dependencies?.length) {
			const allValidDeps = taskData.dependencies.every((depId) => {
				const numDepId = parseInt(depId, 10);
				return (
					!Number.isNaN(numDepId) && allTasks.some((t) => t.id === numDepId)
				);
			});

			if (!allValidDeps) {
				report(
					'AI предложил неверные зависимости. Фильтрация их...',
					'warn'
				);
				newTask.dependencies = taskData.dependencies.filter((depId) => {
					const numDepId = parseInt(depId, 10);
					return (
						!Number.isNaN(numDepId) && allTasks.some((t) => t.id === numDepId)
					);
				});
			}
		}

		// Add the task to the tasks array OF THE CORRECT TAG
		rawData[targetTag].tasks.push(newTask);
		// Update the tag's metadata
		ensureTagMetadata(rawData[targetTag], {
			description: `Задачи для контекста ${targetTag}`
		});

		report('DEBUG: Запись tasks.json...', 'debug');
		// Write the updated raw data back to the file
		// The writeJSON function will automatically filter out _rawTaggedData
		writeJSON(tasksPath, rawData);
		report('DEBUG: tasks.json записан.', 'debug');

		// Generate markdown task files
		// report('Generating task files...', 'info');
		// report('DEBUG: Calling generateTaskFiles...', 'debug');
		// // Pass mcpLog if available to generateTaskFiles
		// await generateTaskFiles(tasksPath, path.dirname(tasksPath), {
		// 	projectRoot,
		// 	tag: targetTag
		// });
		// report('DEBUG: generateTaskFiles finished.', 'debug');

		// Show success message - only for text output (CLI)
		if (outputFormat === 'text') {
			const table = new Table({
				head: [
					chalk.cyan.bold('ID'),
					chalk.cyan.bold('Заголовок'),
					chalk.cyan.bold('Описание')
				],
				colWidths: [5, 30, 50] // Adjust widths as needed
			});

			table.push([
				newTask.id,
				truncate(newTask.title, 27),
				truncate(newTask.description, 47)
			]);

			console.log(chalk.green('✓ Новая задача успешно создана:'));
			console.log(table.toString());

			// Helper to get priority color
			const getPriorityColor = (p) => {
				switch (p?.toLowerCase()) {
					case 'high':
						return 'red';
					case 'low':
						return 'gray';
					default:
						return 'yellow';
				}
			};

			// Check if AI added new dependencies that weren't explicitly provided
			const aiAddedDeps = newTask.dependencies.filter(
				(dep) => !numericDependencies.includes(dep)
			);

			// Check if AI removed any dependencies that were explicitly provided
			const aiRemovedDeps = numericDependencies.filter(
				(dep) => !newTask.dependencies.includes(dep)
			);

			// Get task titles for dependencies to display
			const depTitles = {};
			newTask.dependencies.forEach((dep) => {
				const depTask = allTasks.find((t) => t.id === dep);
				if (depTask) {
					depTitles[dep] = truncate(depTask.title, 30);
				}
			});

			// Prepare dependency display string
			let dependencyDisplay = '';
			if (newTask.dependencies.length > 0) {
				dependencyDisplay = chalk.white('Зависимости:') + '\n';
				newTask.dependencies.forEach((dep) => {
					const isAiAdded = aiAddedDeps.includes(dep);
					const depType = isAiAdded ? chalk.yellow(' (предложено AI)') : '';
					dependencyDisplay +=
						chalk.white(
							`  - ${dep}: ${depTitles[dep] || 'Неизвестная задача'}${depType}`
						) + '\n';
				});
			} else {
				dependencyDisplay = chalk.white('Зависимости: Нет') + '\n';
			}

			// Add info about removed dependencies if any
			if (aiRemovedDeps.length > 0) {
				dependencyDisplay +=
					chalk.gray('\nПользовательские зависимости, которые не были использованы:') +
					'\n';
				aiRemovedDeps.forEach((dep) => {
					const depTask = allTasks.find((t) => t.id === dep);
					const title = depTask ? truncate(depTask.title, 30) : 'Неизвестная задача';
					dependencyDisplay += chalk.gray(`  - ${dep}: ${title}`) + '\n';
				});
			}

			// Add dependency analysis summary
			let dependencyAnalysis = '';
			if (aiAddedDeps.length > 0 || aiRemovedDeps.length > 0) {
				dependencyAnalysis =
					'\n' + chalk.white.bold('Анализ зависимостей:') + '\n';
				if (aiAddedDeps.length > 0) {
					dependencyAnalysis +=
						chalk.green(
							`AI определил ${aiAddedDeps.length} дополнительных зависимостей`
						) + '\n';
				}
				if (aiRemovedDeps.length > 0) {
					dependencyAnalysis +=
						chalk.yellow(
							`AI исключил ${aiRemovedDeps.length} предоставленных пользователем зависимостей`
						) + '\n';
				}
			}

			// Show success message box
			console.log(
				boxen(
					chalk.white.bold(`Задача ${newTaskId} успешно создана`) +
						'\n\n' +
						chalk.white(`Заголовок: ${newTask.title}`) +
						'\n' +
						chalk.white(`Статус: ${getStatusWithColor(newTask.status)}`) +
						'\n' +
						chalk.white(
							`Приоритет: ${chalk[getPriorityColor(newTask.priority)](newTask.priority)}`
						) +
						'\n\n' +
						dependencyDisplay +
						dependencyAnalysis +
						'\n' +
						chalk.white.bold('Следующие шаги:') +
						'\n' +
						chalk.cyan(
							`1. Выполните ${chalk.yellow(`task-master show ${newTaskId}`)}, чтобы увидеть полные детали задачи`
						) +
						'\n' +
						chalk.cyan(
							`2. Выполните ${chalk.yellow(`task-master set-status --id=${newTaskId} --status=in-progress`)}, чтобы начать работу над ней`
						) +
						'\n' +
						chalk.cyan(
							`3. Выполните ${chalk.yellow(`task-master expand --id=${newTaskId}`)}, чтобы разбить ее на подзадачи`
						),
					{ padding: 1, borderColor: 'green', borderStyle: 'round' }
				)
			);

			// Display AI Usage Summary if telemetryData is available
			if (
				aiServiceResponse &&
				aiServiceResponse.telemetryData &&
				(outputType === 'cli' || outputType === 'text')
			) {
				displayAiUsageSummary(aiServiceResponse.telemetryData, 'cli');
			}
		}

		report(
			`DEBUG: Возвращение ID новой задачи: ${newTaskId} и телеметрии.`,
			'debug'
		);
		return {
			newTaskId: newTaskId,
			telemetryData: aiServiceResponse ? aiServiceResponse.telemetryData : null,
			tagInfo: aiServiceResponse ? aiServiceResponse.tagInfo : null
		};
	} catch (error) {
		// Stop any loading indicator on error
		if (loadingIndicator) {
			stopLoadingIndicator(loadingIndicator);
		}

		report(`Ошибка при добавлении задачи: ${error.message}`, 'error');
		if (outputFormat === 'text') {
			console.error(chalk.red(`Ошибка: ${error.message}`));
		}
		// In MCP mode, we let the direct function handler catch and format
		throw error;
	}
}

export default addTask;
