import chalk from 'chalk';
import boxen from 'boxen';
import readline from 'readline';
import fs from 'fs';

import { log, readJSON, writeJSON, isSilentMode } from '../utils.js';

import {
	startLoadingIndicator,
	stopLoadingIndicator,
	displayAiUsageSummary
} from '../ui.js';

import { generateTextService } from '../ai-services-unified.js';

import { getDebugFlag, getProjectName } from '../config-manager.js';
import {
	COMPLEXITY_REPORT_FILE,
	LEGACY_TASKS_FILE
} from '../../../src/constants/paths.js';
import { ContextGatherer } from '../utils/contextGatherer.js';
import { FuzzyTaskSearch } from '../utils/fuzzyTaskSearch.js';
import { flattenTasksWithSubtasks } from '../utils.js';

/**
 * Generates the prompt for complexity analysis.
 * (Moved from ai-services.js and simplified)
 * @param {Object} tasksData - The tasks data object.
 * @param {string} [gatheredContext] - The gathered context for the analysis.
 * @returns {string} The generated prompt.
 */
function generateInternalComplexityAnalysisPrompt(
	tasksData,
	gatheredContext = ''
) {
	const tasksString = JSON.stringify(tasksData.tasks, null, 2);
	let prompt = `Проанализируйте следующие задачи, чтобы определить их сложность (по шкале от 1 до 10) и порекомендовать количество подзадач для расширения. Предоставьте краткое обоснование и начальный промпт для расширения для каждой из них.

Задачи:
${tasksString}`;

	if (gatheredContext) {
		prompt += `\n\n# Контекст проекта\n\n${gatheredContext}`;
	}

	prompt += `

Отвечайте ТОЛЬКО валидным массивом JSON, соответствующим схеме:
[
  {
    "taskId": <number>,
    "taskTitle": "<string>",
    "complexityScore": <number 1-10>,
    "recommendedSubtasks": <number>,
    "expansionPrompt": "<string>",
    "reasoning": "<string>"
  },
  ...
]

Не включайте никакого пояснительного текста, форматирования markdown или маркеров кодовых блоков до или после массива JSON.`;
	return prompt;
}

/**
 * Analyzes task complexity and generates expansion recommendations
 * @param {Object} options Command options
 * @param {string} options.file - Path to tasks file
 * @param {string} options.output - Path to report output file
 * @param {string|number} [options.threshold] - Complexity threshold
 * @param {boolean} [options.research] - Use research role
 * @param {string} [options.projectRoot] - Project root path (for MCP/env fallback).
 * @param {string} [options.id] - Comma-separated list of task IDs to analyze specifically
 * @param {number} [options.from] - Starting task ID in a range to analyze
 * @param {number} [options.to] - Ending task ID in a range to analyze
 * @param {Object} [options._filteredTasksData] - Pre-filtered task data (internal use)
 * @param {number} [options._originalTaskCount] - Original task count (internal use)
 * @param {Object} context - Context object, potentially containing session and mcpLog
 * @param {Object} [context.session] - Session object from MCP server (optional)
 * @param {Object} [context.mcpLog] - MCP logger object (optional)
 * @param {function} [context.reportProgress] - Deprecated: Function to report progress (ignored)
 */
async function analyzeTaskComplexity(options, context = {}) {
	const { session, mcpLog } = context;
	const tasksPath = options.file || LEGACY_TASKS_FILE;
	const outputPath = options.output || COMPLEXITY_REPORT_FILE;
	const thresholdScore = parseFloat(options.threshold || '5');
	const useResearch = options.research || false;
	const projectRoot = options.projectRoot;
	const tag = options.tag;
	// New parameters for task ID filtering
	const specificIds = options.id
		? options.id
				.split(',')
				.map((id) => parseInt(id.trim(), 10))
				.filter((id) => !Number.isNaN(id))
		: null;
	const fromId = options.from !== undefined ? parseInt(options.from, 10) : null;
	const toId = options.to !== undefined ? parseInt(options.to, 10) : null;

	const outputFormat = mcpLog ? 'json' : 'text';

	const reportLog = (message, level = 'info') => {
		if (mcpLog) {
			mcpLog[level](message);
		} else if (!isSilentMode() && outputFormat === 'text') {
			log(level, message);
		}
	};

	if (outputFormat === 'text') {
		console.log(
			chalk.blue(
				'Анализ сложности задач и генерация рекомендаций по расширению...'
			)
		);
	}

	try {
		reportLog(`Чтение задач из ${tasksPath}...`, 'info');
		let tasksData;
		let originalTaskCount = 0;
		let originalData = null;

		if (options._filteredTasksData) {
			tasksData = options._filteredTasksData;
			originalTaskCount = options._originalTaskCount || tasksData.tasks.length;
			if (!options._originalTaskCount) {
				try {
					originalData = readJSON(tasksPath, projectRoot, tag);
					if (originalData && originalData.tasks) {
						originalTaskCount = originalData.tasks.length;
					}
				} catch (e) {
					log('warn', `Не удалось прочитать исходный файл задач: ${e.message}`);
				}
			}
		} else {
			originalData = readJSON(tasksPath, projectRoot, tag);
			if (
				!originalData ||
				!originalData.tasks ||
				!Array.isArray(originalData.tasks) ||
				originalData.tasks.length === 0
			) {
				throw new Error('В файле задач не найдено ни одной задачи');
			}
			originalTaskCount = originalData.tasks.length;

			// Filter tasks based on active status
			const activeStatuses = ['pending', 'blocked', 'in-progress'];
			let filteredTasks = originalData.tasks.filter((task) =>
				activeStatuses.includes(task.status?.toLowerCase() || 'pending')
			);

			// Apply ID filtering if specified
			if (specificIds && specificIds.length > 0) {
				reportLog(
					`Фильтрация задач по определенным ID: ${specificIds.join(', ')}`,
					'info'
				);
				filteredTasks = filteredTasks.filter((task) =>
					specificIds.includes(task.id)
				);

				if (outputFormat === 'text') {
					if (filteredTasks.length === 0 && specificIds.length > 0) {
						console.log(
							chalk.yellow(
								`Предупреждение: не найдено активных задач с ID: ${specificIds.join(', ')}`
							)
						);
					} else if (filteredTasks.length < specificIds.length) {
						const foundIds = filteredTasks.map((t) => t.id);
						const missingIds = specificIds.filter(
							(id) => !foundIds.includes(id)
						);
						console.log(
							chalk.yellow(
								`Предупреждение: некоторые из запрошенных ID задач не были найдены или неактивны: ${missingIds.join(', ')}`
							)
						);
					}
				}
			}
			// Apply range filtering if specified
			else if (fromId !== null || toId !== null) {
				const effectiveFromId = fromId !== null ? fromId : 1;
				const effectiveToId =
					toId !== null
						? toId
						: Math.max(...originalData.tasks.map((t) => t.id));

				reportLog(
					`Фильтрация задач по диапазону ID: от ${effectiveFromId} до ${effectiveToId}`,
					'info'
				);
				filteredTasks = filteredTasks.filter(
					(task) => task.id >= effectiveFromId && task.id <= effectiveToId
				);

				if (outputFormat === 'text' && filteredTasks.length === 0) {
					console.log(
						chalk.yellow(
							`Предупреждение: в диапазоне не найдено активных задач: ${effectiveFromId}-${effectiveToId}`
						)
					);
				}
			}

			tasksData = {
				...originalData,
				tasks: filteredTasks,
				_originalTaskCount: originalTaskCount
			};
		}

		// --- Context Gathering ---
		let gatheredContext = '';
		if (originalData && originalData.tasks.length > 0) {
			try {
				const contextGatherer = new ContextGatherer(projectRoot);
				const allTasksFlat = flattenTasksWithSubtasks(originalData.tasks);
				const fuzzySearch = new FuzzyTaskSearch(
					allTasksFlat,
					'analyze-complexity'
				);
				// Create a query from the tasks being analyzed
				const searchQuery = tasksData.tasks
					.map((t) => `${t.title} ${t.description}`)
					.join(' ');
				const searchResults = fuzzySearch.findRelevantTasks(searchQuery, {
					maxResults: 10
				});
				const relevantTaskIds = fuzzySearch.getTaskIds(searchResults);

				if (relevantTaskIds.length > 0) {
					const contextResult = await contextGatherer.gather({
						tasks: relevantTaskIds,
						format: 'research'
					});
					gatheredContext = contextResult;
				}
			} catch (contextError) {
				reportLog(
					`Не удалось собрать дополнительный контекст: ${contextError.message}`,
					'warn'
				);
			}
		}
		// --- End Context Gathering ---

		const skippedCount = originalTaskCount - tasksData.tasks.length;
		reportLog(
			`Найдено ${originalTaskCount} всего задач в файле задач.`,
			'info'
		);

		// Updated messaging to reflect filtering logic
		if (specificIds || fromId !== null || toId !== null) {
			const filterMsg = specificIds
				? `Анализ ${tasksData.tasks.length} задач с определенными ID: ${specificIds.join(', ')}`
				: `Анализ ${tasksData.tasks.length} задач в диапазоне: от ${fromId || 1} до ${toId || 'конца'}`;

			reportLog(filterMsg, 'info');
			if (outputFormat === 'text') {
				console.log(chalk.blue(filterMsg));
			}
		} else if (skippedCount > 0) {
			const skipMessage = `Пропущено ${skippedCount} задач, отмеченных как выполненные/отмененные/отложенные. Анализ ${tasksData.tasks.length} активных задач.`;
			reportLog(skipMessage, 'info');
			if (outputFormat === 'text') {
				console.log(chalk.yellow(skipMessage));
			}
		}

		// Check for existing report before doing analysis
		let existingReport = null;
		const existingAnalysisMap = new Map(); // For quick lookups by task ID
					try {
				if (fs.existsSync(outputPath)) {
					existingReport = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
					reportLog(`Найден существующий отчет о сложности по адресу ${outputPath}`, 'info');

					if (
						existingReport &&
						existingReport.complexityAnalysis &&
						Array.isArray(existingReport.complexityAnalysis)
					) {
						// Create lookup map of existing analysis entries
						existingReport.complexityAnalysis.forEach((item) => {
							existingAnalysisMap.set(item.taskId, item);
						});
						reportLog(
							`Существующий отчет содержит ${existingReport.complexityAnalysis.length} анализов задач`,
							'info'
						);
					}
				}
			} catch (readError) {
				reportLog(
					`Предупреждение: не удалось прочитать существующий отчет: ${readError.message}`,
					'warn'
				);
				existingReport = null;
				existingAnalysisMap.clear();
			}

		if (tasksData.tasks.length === 0) {
            // If using ID filtering but no matching tasks, return existing report or empty
            if (existingReport && (specificIds || fromId !== null || toId !== null)) {
                reportLog(
                    'Не найдено подходящих задач для анализа. Сохранение существующего отчета.',
                    'info'
                );
                if (outputFormat === 'text') {
                    console.log(
                        chalk.yellow(
                            'Не найдено подходящих задач для анализа. Сохранение существующего отчета.'
                        )
                    );
                }
                return {
                    report: existingReport,
                    telemetryData: null
                };
            }

            // Otherwise create empty report
            const emptyReport = {
                meta: {
                    generatedAt: new Date().toISOString(),
                    tasksAnalyzed: 0,
                    thresholdScore: thresholdScore,
                    projectName: getProjectName(session),
                    usedResearch: useResearch
                },
                complexityAnalysis: existingReport?.complexityAnalysis || []
            };
            reportLog(`Запись отчета о сложности в ${outputPath}...`, 'info');
            fs.writeFileSync(
                outputPath,
                JSON.stringify(emptyReport, null, '\t'),
                'utf8'
            );
            reportLog(
                `Анализ сложности задач завершен. Отчет записан в ${outputPath}`,
                'success'
            );
            if (outputFormat === 'text') {
                console.log(
                    chalk.green(
                        `Анализ сложности задач завершен. Отчет записан в ${outputPath}`
                    )
                );
                const highComplexity = 0;
                const mediumComplexity = 0;
                const lowComplexity = 0;
                const totalAnalyzed = 0;

                console.log('\nСводка анализа сложности:');
                console.log('----------------------------');
                console.log(`Задач во входном файле: ${originalTaskCount}`);
                console.log(`Успешно проанализировано задач: ${totalAnalyzed}`);
                console.log(`Задачи высокой сложности: ${highComplexity}`);
                console.log(`Задачи средней сложности: ${mediumComplexity}`);
                console.log(`Задачи низкой сложности: ${lowComplexity}`);
                console.log(
                    `Проверка суммы: ${highComplexity + mediumComplexity + lowComplexity} (должно равняться ${totalAnalyzed})`
                );
                console.log(`Анализ с использованием исследования: ${useResearch ? 'Да' : 'Нет'}`);
                console.log(
                    `\nСмотрите ${outputPath} для полного отчета и команд расширения.`
                );

                console.log(
                    boxen(
                        chalk.white.bold('Предлагаемые следующие шаги:') +
                            '\n\n' +
                            `${chalk.cyan('1.')} Выполните ${chalk.yellow('task-master complexity-report')}, чтобы просмотреть подробные результаты\n` +
                            `${chalk.cyan('2.')} Выполните ${chalk.yellow('task-master expand --id=<id>')}, чтобы разбить сложные задачи\n` +
                            `${chalk.cyan('3.')} Выполните ${chalk.yellow('task-master expand --all')}, чтобы расширить все ожидающие задачи на основе сложности`,
                        {
                            padding: 1,
                            borderColor: 'cyan',
                            borderStyle: 'round',
                            margin: { top: 1 }
                        }
                    )
                );
            }
            return {
                report: emptyReport,
                telemetryData: null
            };
        }

		// Continue with regular analysis path
		const prompt = generateInternalComplexityAnalysisPrompt(
			tasksData,
			gatheredContext
		);
		const systemPrompt =
			'Вы — экспертный архитектор программного обеспечения и менеджер проектов, анализирующий сложность задач. Отвечайте только запрошенным валидным массивом JSON.';

		let loadingIndicator = null;
		if (outputFormat === 'text') {
			loadingIndicator = startLoadingIndicator(
				`${useResearch ? 'Исследование' : 'Анализ'} сложности ваших задач с помощью AI...\n`
			);
		}

		let aiServiceResponse = null;
		let complexityAnalysis = null;

		try {
			const role = useResearch ? 'research' : 'main';

			aiServiceResponse = await generateTextService({
				prompt,
				systemPrompt,
				role,
				session,
				projectRoot,
				commandName: 'analyze-complexity',
				outputType: mcpLog ? 'mcp' : 'cli'
			});

			if (loadingIndicator) {
				stopLoadingIndicator(loadingIndicator);
				loadingIndicator = null;
			}
			if (outputFormat === 'text') {
				readline.clearLine(process.stdout, 0);
				readline.cursorTo(process.stdout, 0);
				console.log(
					chalk.green('Вызов сервиса AI завершен. Разбор ответа...')
				);
			}

			reportLog('Разбор анализа сложности из текстового ответа...', 'info');
			try {
				let cleanedResponse = aiServiceResponse.mainResult;
				cleanedResponse = cleanedResponse.trim();

				const codeBlockMatch = cleanedResponse.match(
					/```(?:json)?\s*([\s\S]*?)\s*```/
				);
				if (codeBlockMatch) {
					cleanedResponse = codeBlockMatch[1].trim();
				} else {
					const firstBracket = cleanedResponse.indexOf('[');
					const lastBracket = cleanedResponse.lastIndexOf(']');
					if (firstBracket !== -1 && lastBracket > firstBracket) {
						cleanedResponse = cleanedResponse.substring(
							firstBracket,
							lastBracket + 1
						);
					} else {
						reportLog(
							'Предупреждение: Ответ, похоже, не является массивом JSON.',
							'warn'
						);
					}
				}

				if (outputFormat === 'text' && getDebugFlag(session)) {
					console.log(chalk.gray('Попытка разобрать очищенный JSON...'));
					console.log(chalk.gray('Очищенный ответ (первые 100 символов):'));
					console.log(chalk.gray(cleanedResponse.substring(0, 100)));
					console.log(chalk.gray('Последние 100 символов:'));
					console.log(
						chalk.gray(cleanedResponse.substring(cleanedResponse.length - 100))
					);
				}

				complexityAnalysis = JSON.parse(cleanedResponse);
			} catch (parseError) {
				if (loadingIndicator) stopLoadingIndicator(loadingIndicator);
				reportLog(
					`Ошибка разбора JSON анализа сложности: ${parseError.message}`,
					'error'
				);
				if (outputFormat === 'text') {
					console.error(
						chalk.red(
							`Ошибка разбора JSON анализа сложности: ${parseError.message}`
						)
					);
				}
				throw parseError;
			}

			const taskIds = tasksData.tasks.map((t) => t.id);
			const analysisTaskIds = complexityAnalysis.map((a) => a.taskId);
			const missingTaskIds = taskIds.filter(
				(id) => !analysisTaskIds.includes(id)
			);

			if (missingTaskIds.length > 0) {
				reportLog(
					`Отсутствует анализ для ${missingTaskIds.length} задач: ${missingTaskIds.join(', ')}`,
					'warn'
				);
				if (outputFormat === 'text') {
					console.log(
						chalk.yellow(
							`Отсутствует анализ для ${missingTaskIds.length} задач: ${missingTaskIds.join(', ')}`
						)
					);
				}
				for (const missingId of missingTaskIds) {
					const missingTask = tasksData.tasks.find((t) => t.id === missingId);
					if (missingTask) {
						reportLog(`Добавление анализа по умолчанию для задачи ${missingId}`, 'info');
						complexityAnalysis.push({
							taskId: missingId,
							taskTitle: missingTask.title,
							complexityScore: 5,
							recommendedSubtasks: 3,
							expansionPrompt: `Разбейте эту задачу с упором на ${missingTask.title.toLowerCase()}.`,
							reasoning:
								'Автоматически добавлено из-за отсутствия анализа в ответе AI.'
						});
					}
				}
			}

			// Merge with existing report
			let finalComplexityAnalysis = [];

			if (existingReport && Array.isArray(existingReport.complexityAnalysis)) {
				// Create a map of task IDs that we just analyzed
				const analyzedTaskIds = new Set(
					complexityAnalysis.map((item) => item.taskId)
				);

				// Keep existing entries that weren't in this analysis run
				const existingEntriesNotAnalyzed =
					existingReport.complexityAnalysis.filter(
						(item) => !analyzedTaskIds.has(item.taskId)
					);

				// Combine with new analysis
				finalComplexityAnalysis = [
					...existingEntriesNotAnalyzed,
					...complexityAnalysis
				];

				reportLog(
					`Объединено ${complexityAnalysis.length} новых анализов с ${existingEntriesNotAnalyzed.length} существующими записями`,
					'info'
				);
			} else {
				// No existing report or invalid format, just use the new analysis
				finalComplexityAnalysis = complexityAnalysis;
			}

			const report = {
				meta: {
					generatedAt: new Date().toISOString(),
					tasksAnalyzed: tasksData.tasks.length,
					totalTasks: originalTaskCount,
					analysisCount: finalComplexityAnalysis.length,
					thresholdScore: thresholdScore,
					projectName: getProjectName(session),
					usedResearch: useResearch
				},
				complexityAnalysis: finalComplexityAnalysis
			};
			reportLog(`Запись отчета о сложности в ${outputPath}...`, 'info');
			fs.writeFileSync(outputPath, JSON.stringify(report, null, '\t'), 'utf8');

			reportLog(
				`Анализ сложности задач завершен. Отчет записан в ${outputPath}`,
				'success'
			);

			if (outputFormat === 'text') {
				console.log(
					chalk.green(
						`Анализ сложности задач завершен. Отчет записан в ${outputPath}`
					)
				);
				// Calculate statistics specifically for this analysis run
				const highComplexity = complexityAnalysis.filter(
					(t) => t.complexityScore >= 8
				).length;
				const mediumComplexity = complexityAnalysis.filter(
					(t) => t.complexityScore >= 5 && t.complexityScore < 8
				).length;
				const lowComplexity = complexityAnalysis.filter(
					(t) => t.complexityScore < 5
				).length;
				const totalAnalyzed = complexityAnalysis.length;

				console.log('\nСводка текущего анализа:');
				console.log('----------------------------');
				console.log(`Проанализировано задач в этом запуске: ${totalAnalyzed}`);
				console.log(`Задачи высокой сложности: ${highComplexity}`);
				console.log(`Задачи средней сложности: ${mediumComplexity}`);
				console.log(`Задачи низкой сложности: ${lowComplexity}`);

				if (existingReport) {
					console.log('\nСводка обновленного отчета:');
					console.log('----------------------------');
					console.log(
						`Всего анализов в отчете: ${finalComplexityAnalysis.length}`
					);
					console.log(
						`Анализы из предыдущих запусков: ${finalComplexityAnalysis.length - totalAnalyzed}`
					);
					console.log(`Новые/обновленные анализы: ${totalAnalyzed}`);
				}

				console.log(`Анализ с использованием исследования: ${useResearch ? 'Да' : 'Нет'}`);
				console.log(
					`\nСмотрите ${outputPath} для полного отчета и команд расширения.`
				);

				console.log(
					boxen(
						chalk.white.bold('Предлагаемые следующие шаги:') +
							'\n\n' +
							`${chalk.cyan('1.')} Выполните ${chalk.yellow('task-master complexity-report')}, чтобы просмотреть подробные результаты\n` +
							`${chalk.cyan('2.')} Выполните ${chalk.yellow('task-master expand --id=<id>')}, чтобы разбить сложные задачи\n` +
							`${chalk.cyan('3.')} Выполните ${chalk.yellow('task-master expand --all')}, чтобы расширить все ожидающие задачи на основе сложности`,
						{
							padding: 1,
							borderColor: 'cyan',
							borderStyle: 'round',
							margin: { top: 1 }
						}
					)
				);

				if (getDebugFlag(session)) {
					console.debug(
						chalk.gray(
							`Объект окончательного анализа: ${JSON.stringify(report, null, 2)}`
						)
					);
				}

				if (aiServiceResponse.telemetryData) {
					displayAiUsageSummary(aiServiceResponse.telemetryData, 'cli');
				}
			}

			return {
				report: report,
				telemetryData: aiServiceResponse?.telemetryData,
				tagInfo: aiServiceResponse?.tagInfo
			};
		} catch (aiError) {
			if (loadingIndicator) stopLoadingIndicator(loadingIndicator);
			reportLog(`Ошибка во время вызова сервиса AI: ${aiError.message}`, 'error');
			if (outputFormat === 'text') {
				console.error(
					chalk.red(`Ошибка во время вызова сервиса AI: ${aiError.message}`)
				);
				if (aiError.message.includes('API key')) {
					console.log(
						chalk.yellow(
							'\nПожалуйста, убедитесь, что ваши ключи API правильно настроены в .env или ~/.taskmaster/.env'
						)
					);
					console.log(
						chalk.yellow("Выполните 'task-master models --setup', если необходимо.")
					);
				}
			}
			throw aiError;
		} finally {
			if (loadingIndicator) stopLoadingIndicator(loadingIndicator);
		}
	} catch (error) {
		reportLog(`Ошибка анализа сложности задачи: ${error.message}`, 'error');
		if (outputFormat === 'text') {
			console.error(
				chalk.red(`Ошибка анализа сложности задачи: ${error.message}`)
			);
			if (getDebugFlag(session)) {
				console.error(error);
			}
			process.exit(1);
		} else {
			throw error;
		}
	}
}

export default analyzeTaskComplexity;
