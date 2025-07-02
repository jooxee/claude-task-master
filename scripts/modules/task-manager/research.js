/**
 * research.js
 * Core research functionality for AI-powered queries with project context
 */

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import boxen from 'boxen';
import inquirer from 'inquirer';
import { highlight } from 'cli-highlight';
import { ContextGatherer } from '../utils/contextGatherer.js';
import { FuzzyTaskSearch } from '../utils/fuzzyTaskSearch.js';
import { generateTextService } from '../ai-services-unified.js';
import {
	log as consoleLog,
	findProjectRoot,
	readJSON,
	flattenTasksWithSubtasks
} from '../utils.js';
import {
	displayAiUsageSummary,
	startLoadingIndicator,
	stopLoadingIndicator
} from '../ui.js';

/**
 * Perform AI-powered research with project context
 * @param {string} query - Research query/prompt
 * @param {Object} options - Research options
 * @param {Array<string>} [options.taskIds] - Task/subtask IDs for context
 * @param {Array<string>} [options.filePaths] - File paths for context
 * @param {string} [options.customContext] - Additional custom context
 * @param {boolean} [options.includeProjectTree] - Include project file tree
 * @param {string} [options.detailLevel] - Detail level: 'low', 'medium', 'high'
 * @param {string} [options.projectRoot] - Project root directory
 * @param {boolean} [options.saveToFile] - Whether to save results to file (MCP mode)
 * @param {Object} [context] - Execution context
 * @param {Object} [context.session] - MCP session object
 * @param {Object} [context.mcpLog] - MCP logger object
 * @param {string} [context.commandName] - Command name for telemetry
 * @param {string} [context.outputType] - Output type ('cli' or 'mcp')
 * @param {string} [outputFormat] - Output format ('text' or 'json')
 * @param {boolean} [allowFollowUp] - Whether to allow follow-up questions (default: true)
 * @returns {Promise<Object>} Research results with telemetry data
 */
async function performResearch(
	query,
	options = {},
	context = {},
	outputFormat = 'text',
	allowFollowUp = true
) {
	const {
		taskIds = [],
		filePaths = [],
		customContext = '',
		includeProjectTree = false,
		detailLevel = 'medium',
		projectRoot: providedProjectRoot,
		saveToFile = false
	} = options;

	const {
		session,
		mcpLog,
		commandName = 'research',
		outputType = 'cli'
	} = context;
	const isMCP = !!mcpLog;

	// Determine project root
	const projectRoot = providedProjectRoot || findProjectRoot();
	if (!projectRoot) {
		throw new Error('Не удалось определить корневой каталог проекта');
	}

	// Create consistent logger
	const logFn = isMCP
		? mcpLog
		: {
				info: (...args) => consoleLog('info', ...args),
				warn: (...args) => consoleLog('warn', ...args),
				error: (...args) => consoleLog('error', ...args),
				debug: (...args) => consoleLog('debug', ...args),
				success: (...args) => consoleLog('success', ...args)
			};

	// Show UI banner for CLI mode
	if (outputFormat === 'text') {
		console.log(
			boxen(chalk.cyan.bold(`🔍 Запрос AI-исследования`), {
				padding: 1,
				borderColor: 'cyan',
				borderStyle: 'round',
				margin: { top: 1, bottom: 1 }
			})
		);
	}

	try {
		// Initialize context gatherer
		const contextGatherer = new ContextGatherer(projectRoot);

		// Auto-discover relevant tasks using fuzzy search to supplement provided tasks
		let finalTaskIds = [...taskIds]; // Start with explicitly provided tasks
		let autoDiscoveredIds = [];

		try {
			const tasksPath = path.join(
				projectRoot,
				'.taskmaster',
				'tasks',
				'tasks.json'
			);
			const tasksData = await readJSON(tasksPath, projectRoot);

			if (tasksData && tasksData.tasks && tasksData.tasks.length > 0) {
				// Flatten tasks to include subtasks for fuzzy search
				const flattenedTasks = flattenTasksWithSubtasks(tasksData.tasks);
				const fuzzySearch = new FuzzyTaskSearch(flattenedTasks, 'research');
				const searchResults = fuzzySearch.findRelevantTasks(query, {
					maxResults: 8,
					includeRecent: true,
					includeCategoryMatches: true
				});

				autoDiscoveredIds = fuzzySearch.getTaskIds(searchResults);

				// Remove any auto-discovered tasks that were already explicitly provided
				const uniqueAutoDiscovered = autoDiscoveredIds.filter(
					(id) => !finalTaskIds.includes(id)
				);

				// Add unique auto-discovered tasks to the final list
				finalTaskIds = [...finalTaskIds, ...uniqueAutoDiscovered];

				if (outputFormat === 'text' && finalTaskIds.length > 0) {
					// Sort task IDs numerically for better display
					const sortedTaskIds = finalTaskIds
						.map((id) => parseInt(id))
						.sort((a, b) => a - b)
						.map((id) => id.toString());

					// Show different messages based on whether tasks were explicitly provided
					if (taskIds.length > 0) {
						const sortedProvidedIds = taskIds
							.map((id) => parseInt(id))
							.sort((a, b) => a - b)
							.map((id) => id.toString());

						console.log(
							chalk.gray('Предоставленные задачи: ') +
								chalk.cyan(sortedProvidedIds.join(', '))
						);

						if (uniqueAutoDiscovered.length > 0) {
							const sortedAutoIds = uniqueAutoDiscovered
								.map((id) => parseInt(id))
								.sort((a, b) => a - b)
								.map((id) => id.toString());

							console.log(
								chalk.gray('+ Автоматически обнаруженные связанные задачи: ') +
									chalk.cyan(sortedAutoIds.join(', '))
							);
						}
					} else {
						console.log(
							chalk.gray('Автоматически обнаруженные релевантные задачи: ') +
								chalk.cyan(sortedTaskIds.join(', '))
						);
					}
				}
			}
		} catch (error) {
			// Silently continue without auto-discovered tasks if there's an error
			logFn.debug(`Не удалось автоматически обнаружить задачи: ${error.message}`);
		}

		const contextResult = await contextGatherer.gather({
			tasks: finalTaskIds,
			files: filePaths,
			customContext,
			includeProjectTree,
			format: 'research', // Use research format for AI consumption
			includeTokenCounts: true
		});

		const gatheredContext = contextResult.context;
		const tokenBreakdown = contextResult.tokenBreakdown;

		// Build system prompt based on detail level
		const systemPrompt = buildResearchSystemPrompt(detailLevel, projectRoot);

		// Build user prompt with context
		const userPrompt = buildResearchUserPrompt(
			query,
			gatheredContext,
			detailLevel
		);

		// Count tokens for system and user prompts
		const systemPromptTokens = contextGatherer.countTokens(systemPrompt);
		const userPromptTokens = contextGatherer.countTokens(userPrompt);
		const totalInputTokens = systemPromptTokens + userPromptTokens;

		if (outputFormat === 'text') {
			// Display detailed token breakdown in a clean box
			displayDetailedTokenBreakdown(
				tokenBreakdown,
				systemPromptTokens,
				userPromptTokens
			);
		}

		// Only log detailed info in debug mode or MCP
		if (outputFormat !== 'text') {
			logFn.info(
				`Вызов AI-сервиса с ролью исследования, размер контекста: ${tokenBreakdown.total} токенов (${gatheredContext.length} символов)`
			);
		}

		// Start loading indicator for CLI mode
		let loadingIndicator = null;
		if (outputFormat === 'text') {
			loadingIndicator = startLoadingIndicator('Исследование с помощью AI...');
		}

		let aiResult;
		try {
			// Call AI service with research role
			aiResult = await generateTextService({
				role: 'research', // Always use research role for research command
				session,
				projectRoot,
				systemPrompt,
				prompt: userPrompt,
				commandName,
				outputType
			});
		} catch (error) {
			if (loadingIndicator) {
				stopLoadingIndicator(loadingIndicator);
			}
			throw error;
		} finally {
			if (loadingIndicator) {
				stopLoadingIndicator(loadingIndicator);
			}
		}

		const researchResult = aiResult.mainResult;
		const telemetryData = aiResult.telemetryData;
		const tagInfo = aiResult.tagInfo;

		// Format and display results
		// Initialize interactive save tracking
		let interactiveSaveInfo = { interactiveSaveOccurred: false };

		if (outputFormat === 'text') {
			displayResearchResults(
				researchResult,
				query,
				detailLevel,
				tokenBreakdown
			);

			// Display AI usage telemetry for CLI users
			if (telemetryData) {
				displayAiUsageSummary(telemetryData, 'cli');
			}

			// Offer follow-up question option (only for initial CLI queries, not MCP)
			if (allowFollowUp && !isMCP) {
				interactiveSaveInfo = await handleFollowUpQuestions(
					options,
					context,
					outputFormat,
					projectRoot,
					logFn,
					query,
					researchResult
				);
			}
		}

		// Handle MCP save-to-file request
		if (saveToFile && isMCP) {
			const conversationHistory = [
				{
					question: query,
					answer: researchResult,
					type: 'initial',
					timestamp: new Date().toISOString()
				}
			];

			const savedFilePath = await handleSaveToFile(
				conversationHistory,
				projectRoot,
				context,
				logFn
			);

			// Add saved file path to return data
			return {
				query,
				result: researchResult,
				contextSize: gatheredContext.length,
				contextTokens: tokenBreakdown.total,
				tokenBreakdown,
				systemPromptTokens,
				userPromptTokens,
				totalInputTokens,
				detailLevel,
				telemetryData,
				tagInfo,
				savedFilePath,
				interactiveSaveOccurred: false // MCP save-to-file doesn't count as interactive save
			};
		}

		logFn.success('Запрос исследования успешно завершен');

		return {
			query,
			result: researchResult,
			contextSize: gatheredContext.length,
			contextTokens: tokenBreakdown.total,
			tokenBreakdown,
			systemPromptTokens,
			userPromptTokens,
			totalInputTokens,
			detailLevel,
			telemetryData,
			tagInfo,
			interactiveSaveOccurred:
				interactiveSaveInfo?.interactiveSaveOccurred || false
		};
	} catch (error) {
		logFn.error(`Запрос исследования не удался: ${error.message}`);

		if (outputFormat === 'text') {
			console.error(chalk.red(`
❌ Исследование не удалось: ${error.message}`));
		}

		throw error;
	}
}

/**
 * Build system prompt for research based on detail level
 * @param {string} detailLevel - Detail level: 'low', 'medium', 'high'
 * @param {string} projectRoot - Project root for context
 * @returns {string} System prompt
 */
function buildResearchSystemPrompt(detailLevel, projectRoot) {
	const basePrompt = `Вы — экспертный AI-ассистент по исследованиям, помогающий в проекте по разработке программного обеспечения. У вас есть доступ к контексту проекта, включая задачи, файлы и структуру проекта.

Ваша роль — предоставлять всеобъемлющие, точные и действенные результаты исследований на основе запроса пользователя и предоставленного контекста проекта.`;

	const detailInstructions = {
		low: `
**Стиль ответа: Краткий и прямой**
- Предоставляйте краткие, сфокусированные ответы (максимум 2-4 абзаца)
- Сосредоточьтесь на самой важной информации
- Используйте маркированные списки для ключевых выводов
- Избегайте длинных объяснений, если это не критично
- Пропускайте любезности, вступления и заключения
- Никаких фраз типа "На основе контекста вашего проекта" или "Я предоставлю руководство"
- Никаких итоговых резюме или заявлений о соответствии
- Переходите сразу к действенной информации
- Используйте простой, прямой язык - пользователям нужна информация, а не объяснения`,

		medium: `
**Стиль ответа: Сбалансированный и всеобъемлющий**
- Предоставляйте подробные, но хорошо структурированные ответы (4-8 абзацев)
- Включайте соответствующие примеры и объяснения
- Балансируйте глубину с читабельностью
- Используйте заголовки и маркированные списки для организации`,

		high: `
**Стиль ответа: Подробный и исчерпывающий**
- Предоставляйте всеобъемлющий, углубленный анализ (8+ абзацев)
- Включайте несколько точек зрения и подходов
- Предоставляйте подробные примеры, фрагменты кода и пошаговые инструкции
- Охватывайте крайние случаи и потенциальные ловушки
- Используйте четкую структуру с заголовками, подзаголовками и списками`
	};

	return `${basePrompt}

${detailInstructions[detailLevel]}

**Руководство:**
- Всегда учитывайте контекст проекта при формулировании ответов
- Ссылайтесь на конкретные задачи, файлы или элементы проекта, когда это уместно
- Предоставляйте действенные идеи, которые могут быть применены к проекту
- Если запрос относится к существующим задачам проекта, предложите, как исследование применяется к этим задачам
- Используйте форматирование markdown для лучшей читабельности
- Будьте точны и избегайте предположений, если они явно не обозначены как таковые

**Для НИЗКОГО уровня детализации специально:**
- Начинайте сразу с основной информации
- Никаких вводных фраз или подтверждений контекста
- Никаких заключительных резюме или заявлений о соответствии проекту
- Сосредоточьтесь исключительно на фактах, шагах и действенных элементах`;
}

/**
 * Build user prompt with query and context
 * @param {string} query - User's research query
 * @param {string} gatheredContext - Gathered project context
 * @param {string} detailLevel - Detail level for response guidance
 * @returns {string} Complete user prompt
 */
function buildResearchUserPrompt(query, gatheredContext, detailLevel) {
	let prompt = `# Запрос исследования

${query}`;

	if (gatheredContext && gatheredContext.trim()) {
		prompt += `

# Контекст проекта

${gatheredContext}`;
	}

	prompt += `

# Инструкции

Пожалуйста, исследуйте и предоставьте ответ на запрос выше с уровнем детализации ${detailLevel}. Учитывайте предоставленный контекст проекта и сделайте ваш ответ максимально релевантным и действенным для этого конкретного проекта.`;

	return prompt;
}

/**
 * Display detailed token breakdown for context and prompts
 * @param {Object} tokenBreakdown - Token breakdown from context gatherer
 * @param {number} systemPromptTokens - System prompt token count
 * @param {number} userPromptTokens - User prompt token count
 */
function displayDetailedTokenBreakdown(
	tokenBreakdown,
	systemPromptTokens,
	userPromptTokens
) {
	const parts = [];

	// Custom context
	if (tokenBreakdown.customContext) {
		parts.push(
			chalk.cyan('Пользовательский: ') +
				chalk.yellow(tokenBreakdown.customContext.tokens.toLocaleString())
		);
	}

	// Tasks breakdown
	if (tokenBreakdown.tasks && tokenBreakdown.tasks.length > 0) {
		const totalTaskTokens = tokenBreakdown.tasks.reduce(
			(sum, task) => sum + task.tokens,
			0
		);
		const taskDetails = tokenBreakdown.tasks
			.map((task) => {
				const titleDisplay =
					task.title.length > 30
						? task.title.substring(0, 30) + '...'
						: task.title;
				return `  ${chalk.gray(task.id)} ${chalk.white(titleDisplay)} ${chalk.yellow(task.tokens.toLocaleString())} tokens`;
			})
			.join('\n');

		parts.push(
			chalk.cyan('Задачи: ') +
				chalk.yellow(totalTaskTokens.toLocaleString()) +
				chalk.gray(` (${tokenBreakdown.tasks.length} элементов)`) +
				'\n' +
				taskDetails
		);
	}

	// Files breakdown
	if (tokenBreakdown.files && tokenBreakdown.files.length > 0) {
		const totalFileTokens = tokenBreakdown.files.reduce(
			(sum, file) => sum + file.tokens,
			0
		);
		const fileDetails = tokenBreakdown.files
			.map((file) => {
				const pathDisplay =
					file.path.length > 40
						? '...' + file.path.substring(file.path.length - 37)
						: file.path;
				return `  ${chalk.gray(pathDisplay)} ${chalk.yellow(file.tokens.toLocaleString())} tokens ${chalk.gray(`(${file.sizeKB}KB)`)}`;
			})
			.join('\n');

		parts.push(
			chalk.cyan('Файлы: ') +
				chalk.yellow(totalFileTokens.toLocaleString()) +
				chalk.gray(` (${tokenBreakdown.files.length} файлов)`) +
				'\n' +
				fileDetails
		);
	}

	// Project tree
	if (tokenBreakdown.projectTree) {
		parts.push(
			chalk.cyan('Дерево проекта: ') +
				chalk.yellow(tokenBreakdown.projectTree.tokens.toLocaleString()) +
				chalk.gray(
					` (${tokenBreakdown.projectTree.fileCount} файлов, ${tokenBreakdown.projectTree.dirCount} каталогов)`
				)
		);
	}

	// Prompts breakdown
	const totalPromptTokens = systemPromptTokens + userPromptTokens;
	const promptDetails = [
		`  ${chalk.gray('System:')} ${chalk.yellow(systemPromptTokens.toLocaleString())} tokens`,
		`  ${chalk.gray('User:')} ${chalk.yellow(userPromptTokens.toLocaleString())} tokens`
	].join('\n');

	parts.push(
		chalk.cyan('Промпты: ') +
			chalk.yellow(totalPromptTokens.toLocaleString()) +
			chalk.gray(' (сгенерировано)') +
			'\n' +
			promptDetails
	);

	// Display the breakdown in a clean box
	if (parts.length > 0) {
		const content = parts.join('\n\n');
		const tokenBox = boxen(content, {
			title: chalk.blue.bold('Анализ контекста'),
			titleAlignment: 'left',
			padding: { top: 1, bottom: 1, left: 2, right: 2 },
			margin: { top: 0, bottom: 1 },
			borderStyle: 'single',
			borderColor: 'blue'
		});
		console.log(tokenBox);
	}
}

/**
 * Process research result text to highlight code blocks
 * @param {string} text - Raw research result text
 * @returns {string} Processed text with highlighted code blocks
 */
function processCodeBlocks(text) {
	// Regex to match code blocks with optional language specification
	const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;

	return text.replace(codeBlockRegex, (match, language, code) => {
		try {
			// Default to javascript if no language specified
			const lang = language || 'javascript';

			// Highlight the code using cli-highlight
			const highlightedCode = highlight(code.trim(), {
				language: lang,
				ignoreIllegals: true // Don't fail on unrecognized syntax
			});

			// Add a subtle border around code blocks
			const codeBox = boxen(highlightedCode, {
				padding: { top: 0, bottom: 0, left: 1, right: 1 },
				margin: { top: 0, bottom: 0 },
				borderStyle: 'single',
				borderColor: 'dim'
			});

			return '\n' + codeBox + '\n';
		} catch (error) {
			// If highlighting fails, return the original code block with basic formatting
			return (
				'\n' +
				chalk.gray('```' + (language || '')) +
				'\n' +
				chalk.white(code.trim()) +
				'\n' +
				chalk.gray('```') +
				'\n'
			);
		}
	});
}

/**
 * Display research results in formatted output
 * @param {string} result - AI research result
 * @param {string} query - Original query
 * @param {string} detailLevel - Detail level used
 * @param {Object} tokenBreakdown - Detailed token usage
 */
function displayResearchResults(result, query, detailLevel, tokenBreakdown) {
	// Header with query info
	const header = boxen(
		chalk.green.bold('Результаты исследования') +
			'\n\n' +
			chalk.gray('Запрос: ') +
			chalk.white(query) +
			'\n' +
			chalk.gray('Уровень детализации: ') +
			chalk.cyan(detailLevel),
		{
			padding: { top: 1, bottom: 1, left: 2, right: 2 },
			margin: { top: 1, bottom: 0 },
			borderStyle: 'round',
			borderColor: 'green'
		}
	);
	console.log(header);

	// Process the result to highlight code blocks
	const processedResult = processCodeBlocks(result);

	// Main research content in a clean box
	const contentBox = boxen(processedResult, {
		padding: { top: 1, bottom: 1, left: 2, right: 2 },
		margin: { top: 0, bottom: 1 },
		borderStyle: 'single',
		borderColor: 'gray'
	});
	console.log(contentBox);

	// Success footer
	console.log(chalk.green('✅ Исследование завершено'));
}

/**
 * Handle follow-up questions and save functionality in interactive mode
 * @param {Object} originalOptions - Original research options
 * @param {Object} context - Execution context
 * @param {string} outputFormat - Output format
 * @param {string} projectRoot - Project root directory
 * @param {Object} logFn - Logger function
 * @param {string} initialQuery - Initial query for context
 * @param {string} initialResult - Initial AI result for context
 */
async function handleFollowUpQuestions(
	originalOptions,
	context,
	outputFormat,
	projectRoot,
	logFn,
	initialQuery,
	initialResult
) {
	let interactiveSaveOccurred = false;

	try {
		// Import required modules for saving
		const { readJSON } = await import('../utils.js');
		const updateTaskById = (await import('./update-task-by-id.js')).default;
		const { updateSubtaskById } = await import('./update-subtask-by-id.js');

		// Initialize conversation history with the initial Q&A
		const conversationHistory = [
			{
				question: initialQuery,
				answer: initialResult,
				type: 'initial',
				timestamp: new Date().toISOString()
			}
		];

		while (true) {
			// Get user choice
			const { action } = await inquirer.prompt([
				{
					type: 'list',
					name: 'action',
					message: 'Что бы вы хотели сделать дальше?',
					choices: [
						{ name: 'Задать дополнительный вопрос', value: 'followup' },
						{ name: 'Сохранить в файл', value: 'savefile' },
						{ name: 'Сохранить в задачу/подзадачу', value: 'save' },
						{ name: 'Выйти', value: 'quit' }
					],
					pageSize: 4
				}
			]);

			if (action === 'quit') {
				break;
			}

			if (action === 'savefile') {
				// Handle save to file functionality
				await handleSaveToFile(
					conversationHistory,
					projectRoot,
					context,
					logFn
				);
				continue;
			}

			if (action === 'save') {
				// Handle save functionality
				const saveResult = await handleSaveToTask(
					conversationHistory,
					projectRoot,
					context,
					logFn
				);
				if (saveResult) {
					interactiveSaveOccurred = true;
				}
				continue;
			}

			if (action === 'followup') {
				// Get the follow-up question
				const { followUpQuery } = await inquirer.prompt([
					{
						type: 'input',
						name: 'followUpQuery',
						message: 'Введите ваш дополнительный вопрос:',
						validate: (input) => {
							if (!input || input.trim().length === 0) {
								return 'Пожалуйста, введите действительный вопрос.';
							}
							return true;
						}
					}
				]);

				if (!followUpQuery || followUpQuery.trim().length === 0) {
					continue;
				}

				console.log('\n' + chalk.gray('─'.repeat(60)) + '\n');

				// Build cumulative conversation context from all previous exchanges
				const conversationContext =
					buildConversationContext(conversationHistory);

				// Create enhanced options for follow-up with full conversation context
				const followUpOptions = {
					...originalOptions,
					taskIds: [], // Clear task IDs to allow fresh fuzzy search
					customContext:
						conversationContext +
						(originalOptions.customContext
							? `\n\n--- Original Context ---\n${originalOptions.customContext}`
							: '')
				};

				// Perform follow-up research
				const followUpResult = await performResearch(
					followUpQuery.trim(),
					followUpOptions,
					context,
					outputFormat,
					false // allowFollowUp = false for nested calls
				);

				// Add this exchange to the conversation history
				conversationHistory.push({
					question: followUpQuery.trim(),
					answer: followUpResult.result,
					type: 'followup',
					timestamp: new Date().toISOString()
				});
			}
		}
	} catch (error) {
		// If there's an error with inquirer (e.g., non-interactive terminal),
		// silently continue without follow-up functionality
		logFn.debug(`Последующие вопросы недоступны: ${error.message}`);
	}

	return { interactiveSaveOccurred };
}

/**
 * Handle saving conversation to a task or subtask
 * @param {Array} conversationHistory - Array of conversation exchanges
 * @param {string} projectRoot - Project root directory
 * @param {Object} context - Execution context
 * @param {Object} logFn - Logger function
 */
async function handleSaveToTask(
	conversationHistory,
	projectRoot,
	context,
	logFn
) {
	try {
		// Import required modules
		const { readJSON } = await import('../utils.js');
		const updateTaskById = (await import('./update-task-by-id.js')).default;
		const { updateSubtaskById } = await import('./update-subtask-by-id.js');

		// Get task ID from user
		const { taskId } = await inquirer.prompt([
			{
				type: 'input',
				name: 'taskId',
				message: 'Введите ID задачи (например, "15" для задачи или "15.2" для подзадачи):',
				validate: (input) => {
					if (!input || input.trim().length === 0) {
						return 'Пожалуйста, введите ID задачи.';
					}

					const trimmedInput = input.trim();
					// Validate format: number or number.number
					if (!/^\d+(\.\d+)?$/.test(trimmedInput)) {
						return 'Неверный формат. Используйте "15" для задачи или "15.2" для подзадачи.';
					}

					return true;
				}
			}
		]);

		const trimmedTaskId = taskId.trim();

		// Format conversation thread for saving
		const conversationThread = formatConversationForSaving(conversationHistory);

		// Determine if it's a task or subtask
		const isSubtask = trimmedTaskId.includes('.');

		// Try to save - first validate the ID exists
		const tasksPath = path.join(
			projectRoot,
			'.taskmaster',
			'tasks',
			'tasks.json'
		);

		if (!fs.existsSync(tasksPath)) {
			console.log(
				chalk.red('❌ Файл задач не найден. Пожалуйста, сначала запустите task-master init.')
			);
			return;
		}

		// Validate ID exists - use tag from context
		const { getCurrentTag } = await import('../utils.js');
		const tag = context.tag || getCurrentTag(projectRoot) || 'master';
		const data = readJSON(tasksPath, projectRoot, tag);
		if (!data || !data.tasks) {
			console.log(chalk.red('❌ Не найдено допустимых задач.'));
			return;
		}

		if (isSubtask) {
			// Validate subtask exists
			const [parentId, subtaskId] = trimmedTaskId
				.split('.')
				.map((id) => parseInt(id, 10));
			const parentTask = data.tasks.find((t) => t.id === parentId);

			if (!parentTask) {
				console.log(chalk.red(`❌ Родительская задача ${parentId} не найдена.`));
				return;
			}

			if (
				!parentTask.subtasks ||
				!parentTask.subtasks.find((st) => st.id === subtaskId)
			) {
				console.log(chalk.red(`❌ Подзадача ${trimmedTaskId} не найдена.`));
				return;
			}

			// Save to subtask using updateSubtaskById
			console.log(chalk.blue('💾 Сохранение результатов исследования в подзадачу...'));

			await updateSubtaskById(
				tasksPath,
				trimmedTaskId,
				conversationThread,
				false, // useResearch = false for simple append
				{ ...context, tag },
				'text'
			);

			console.log(
				chalk.green(
					`✅ Результаты исследования сохранены в подзадачу ${trimmedTaskId}`
				)
			);
		} else {
			// Validate task exists
			const taskIdNum = parseInt(trimmedTaskId, 10);
			const task = data.tasks.find((t) => t.id === taskIdNum);

			if (!task) {
				console.log(chalk.red(`❌ Задача ${trimmedTaskId} не найдена.`));
				return;
			}

			// Save to task using updateTaskById with append mode
			console.log(chalk.blue('💾 Сохранение результатов исследования в задачу...'));

			await updateTaskById(
				tasksPath,
				taskIdNum,
				conversationThread,
				false, // useResearch = false for simple append
				{ ...context, tag },
				'text',
				true // appendMode = true
			);

			console.log(
				chalk.green(`✅ Результаты исследования сохранены в задачу ${trimmedTaskId}`)
			);
		}

		return true; // Indicate successful save
	} catch (error) {
		console.log(chalk.red(`❌ Ошибка сохранения разговора: ${error.message}`));
		logFn.error(`Ошибка сохранения разговора: ${error.message}`);
		return false; // Indicate failed save
	}
}

/**
 * Handle saving conversation to a file in .taskmaster/docs/research/
 * @param {Array} conversationHistory - Array of conversation exchanges
 * @param {string} projectRoot - Project root directory
 * @param {Object} context - Execution context
 * @param {Object} logFn - Logger function
 * @returns {Promise<string>} Path to saved file
 */
async function handleSaveToFile(
	conversationHistory,
	projectRoot,
	context,
	logFn
) {
	try {
		// Create research directory if it doesn't exist
		const researchDir = path.join(
			projectRoot,
			'.taskmaster',
			'docs',
			'research'
		);
		if (!fs.existsSync(researchDir)) {
			fs.mkdirSync(researchDir, { recursive: true });
		}

		// Generate filename from first query and timestamp
		const firstQuery = conversationHistory[0]?.question || 'research-query';
		const timestamp = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format

		// Create a slug from the query (remove special chars, limit length)
		const querySlug = firstQuery
			.toLowerCase()
			.replace(/[^a-z0-9\s-]/g, '') // Remove special characters
			.replace(/\s+/g, '-') // Replace spaces with hyphens
			.replace(/-+/g, '-') // Replace multiple hyphens with single
			.substring(0, 50) // Limit length
			.replace(/^-+|-+$/g, ''); // Remove leading/trailing hyphens

		const filename = `${timestamp}_${querySlug}.md`;
		const filePath = path.join(researchDir, filename);

		// Format conversation for file
		const fileContent = formatConversationForFile(
			conversationHistory,
			firstQuery
		);

		// Write file
		fs.writeFileSync(filePath, fileContent, 'utf8');

		const relativePath = path.relative(projectRoot, filePath);
		console.log(
			chalk.green(`✅ Исследование сохранено в: ${chalk.cyan(relativePath)}`)
		);

		logFn.success(`Разговор исследования сохранен в ${relativePath}`);

		return filePath;
	} catch (error) {
		console.log(chalk.red(`❌ Ошибка сохранения файла исследования: ${error.message}`));
		logFn.error(`Ошибка сохранения файла исследования: ${error.message}`);
		throw error;
	}
}

/**
 * Format conversation history for saving to a file
 * @param {Array} conversationHistory - Array of conversation exchanges
 * @param {string} initialQuery - The initial query for metadata
 * @returns {string} Formatted file content
 */
function formatConversationForFile(conversationHistory, initialQuery) {
	const timestamp = new Date().toISOString();
	const date = new Date().toLocaleDateString();
	const time = new Date().toLocaleTimeString();

	// Create metadata header
	let content = `---
title: Research Session
query: "${initialQuery}"
date: ${date}
time: ${time}
timestamp: ${timestamp}
exchanges: ${conversationHistory.length}
---

# Research Session

`;

	// Add each conversation exchange
	conversationHistory.forEach((exchange, index) => {
		if (exchange.type === 'initial') {
			content += `## Initial Query\n\n**Question:** ${exchange.question}\n\n**Response:**\n\n${exchange.answer}\n\n`;
		} else {
			content += `## Follow-up ${index}\n\n**Question:** ${exchange.question}\n\n**Response:**\n\n${exchange.answer}\n\n`;
		}

		if (index < conversationHistory.length - 1) {
			content += '---\n\n';
		}
	});

	// Add footer
	content += `\n---\n\n*Generated by Task Master Research Command*  \n*Timestamp: ${timestamp}*\n`;

	return content;
}

/**
 * Format conversation history for saving to a task/subtask
 * @param {Array} conversationHistory - Array of conversation exchanges
 * @returns {string} Formatted conversation thread
 */
function formatConversationForSaving(conversationHistory) {
	const timestamp = new Date().toISOString();
	let formatted = `## Research Session - ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}\n\n`;

	conversationHistory.forEach((exchange, index) => {
		if (exchange.type === 'initial') {
			formatted += `**Initial Query:** ${exchange.question}\n\n`;
			formatted += `**Response:** ${exchange.answer}\n\n`;
		} else {
			formatted += `**Follow-up ${index}:** ${exchange.question}\n\n`;
			formatted += `**Response:** ${exchange.answer}\n\n`;
		}

		if (index < conversationHistory.length - 1) {
			formatted += '---\n\n';
		}
	});

	return formatted;
}

/**
 * Build conversation context string from conversation history
 * @param {Array} conversationHistory - Array of conversation exchanges
 * @returns {string} Formatted conversation context
 */
function buildConversationContext(conversationHistory) {
	if (conversationHistory.length === 0) {
		return '';
	}

	const contextParts = ['--- Conversation History ---'];

	conversationHistory.forEach((exchange, index) => {
		const questionLabel =
			exchange.type === 'initial' ? 'Initial Question' : `Follow-up ${index}`;
		const answerLabel =
			exchange.type === 'initial' ? 'Initial Answer' : `Answer ${index}`;

		contextParts.push(`\n${questionLabel}: ${exchange.question}`);
		contextParts.push(`${answerLabel}: ${exchange.answer}`);
	});

	return contextParts.join('\n');
}

export { performResearch };
