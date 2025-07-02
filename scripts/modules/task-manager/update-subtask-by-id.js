import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import boxen from 'boxen';
import Table from 'cli-table3';

import {
	getStatusWithColor,
	startLoadingIndicator,
	stopLoadingIndicator,
	displayAiUsageSummary
} from '../ui.js';
import {
	log as consoleLog,
	readJSON,
	writeJSON,
	truncate,
	isSilentMode,
	findProjectRoot,
	flattenTasksWithSubtasks,
	getCurrentTag
} from '../utils.js';
import { generateTextService } from '../ai-services-unified.js';
import { getDebugFlag } from '../config-manager.js';
import generateTaskFiles from './generate-task-files.js';
import { ContextGatherer } from '../utils/contextGatherer.js';
import { FuzzyTaskSearch } from '../utils/fuzzyTaskSearch.js';

/**
 * Update a subtask by appending additional timestamped information using the unified AI service.
 * @param {string} tasksPath - Path to the tasks.json file
 * @param {string} subtaskId - ID of the subtask to update in format "parentId.subtaskId"
 * @param {string} prompt - Prompt for generating additional information
 * @param {boolean} [useResearch=false] - Whether to use the research AI role.
 * @param {Object} context - Context object containing session and mcpLog.
 * @param {Object} [context.session] - Session object from MCP server.
 * @param {Object} [context.mcpLog] - MCP logger object.
 * @param {string} [context.projectRoot] - Project root path (needed for AI service key resolution).
 * @param {string} [outputFormat='text'] - Output format ('text' or 'json'). Automatically 'json' if mcpLog is present.
 * @returns {Promise<Object|null>} - The updated subtask or null if update failed.
 */
async function updateSubtaskById(
	tasksPath,
	subtaskId,
	prompt,
	useResearch = false,
	context = {},
	outputFormat = context.mcpLog ? 'json' : 'text'
) {
	const { session, mcpLog, projectRoot: providedProjectRoot, tag } = context;
	const logFn = mcpLog || consoleLog;
	const isMCP = !!mcpLog;

	// Report helper
	const report = (level, ...args) => {
		if (isMCP) {
			if (typeof logFn[level] === 'function') logFn[level](...args);
			else logFn.info(...args);
		} else if (!isSilentMode()) {
			logFn(level, ...args);
		}
	};

	let loadingIndicator = null;

	try {
		report('info', `Обновление подзадачи ${subtaskId} с промптом: "${prompt}"`);

		if (
			!subtaskId ||
			typeof subtaskId !== 'string' ||
			!subtaskId.includes('.')
		) {
			throw new Error(
				`Неверный формат ID подзадачи: ${subtaskId}. ID подзадачи должен быть в формате "parentId.subtaskId"`
			);
		}

		if (!prompt || typeof prompt !== 'string' || prompt.trim() === '') {
			throw new Error(
				'Промпт не может быть пустым. Пожалуйста, предоставьте контекст для обновления подзадачи.'
			);
		}

		if (!fs.existsSync(tasksPath)) {
			throw new Error(`Файл задач не найден по пути: ${tasksPath}`);
		}

		const projectRoot = providedProjectRoot || findProjectRoot();
		if (!projectRoot) {
			throw new Error('Не удалось определить корневой каталог проекта');
		}

		// Determine the tag to use
		const currentTag = tag || getCurrentTag(projectRoot) || 'master';

		const data = readJSON(tasksPath, projectRoot, currentTag);
		if (!data || !data.tasks) {
			throw new Error(
				`В ${tasksPath} не найдено допустимых задач. Файл может быть поврежден или иметь неверный формат.`
			);
		}

		const [parentIdStr, subtaskIdStr] = subtaskId.split('.');
		const parentId = parseInt(parentIdStr, 10);
		const subtaskIdNum = parseInt(subtaskIdStr, 10);

		if (
			Number.isNaN(parentId) ||
			parentId <= 0 ||
			Number.isNaN(subtaskIdNum) ||
			subtaskIdNum <= 0
		) {
			throw new Error(
				`Неверный формат ID подзадачи: ${subtaskId}. Оба ID родительской задачи и подзадачи должны быть положительными целыми числами.`
			);
		}

		const parentTask = data.tasks.find((task) => task.id === parentId);
		if (!parentTask) {
			throw new Error(
				`Родительская задача с ID ${parentId} не найдена. Пожалуйста, проверьте ID задачи и повторите попытку.`
			);
		}

		if (!parentTask.subtasks || !Array.isArray(parentTask.subtasks)) {
			throw new Error(`Родительская задача ${parentId} не имеет подзадач.`);
		}

		const subtaskIndex = parentTask.subtasks.findIndex(
			(st) => st.id === subtaskIdNum
		);
		if (subtaskIndex === -1) {
			throw new Error(
				`Подзадача с ID ${subtaskId} не найдена. Пожалуйста, проверьте ID подзадачи и повторите попытку.`
			);
		}

		const subtask = parentTask.subtasks[subtaskIndex];

		// --- Context Gathering ---
		let gatheredContext = '';
		try {
			const contextGatherer = new ContextGatherer(projectRoot);
			const allTasksFlat = flattenTasksWithSubtasks(data.tasks);
			const fuzzySearch = new FuzzyTaskSearch(allTasksFlat, 'update-subtask');
			const searchQuery = `${parentTask.title} ${subtask.title} ${prompt}`;
			const searchResults = fuzzySearch.findRelevantTasks(searchQuery, {
				maxResults: 5,
				includeSelf: true
			});
			const relevantTaskIds = fuzzySearch.getTaskIds(searchResults);

			const finalTaskIds = [
				...new Set([subtaskId.toString(), ...relevantTaskIds])
			];

			if (finalTaskIds.length > 0) {
				const contextResult = await contextGatherer.gather({
					tasks: finalTaskIds,
					format: 'research'
				});
				gatheredContext = contextResult;
			}
		} catch (contextError) {
			report('warn', `Не удалось собрать контекст: ${contextError.message}`);
		}
		// --- End Context Gathering ---

		if (outputFormat === 'text') {
			const table = new Table({
				head: [
					chalk.cyan.bold('ID'),
					chalk.cyan.bold('Заголовок'),
					chalk.cyan.bold('Статус')
				],
				colWidths: [10, 55, 10]
			});
			table.push([
				subtaskId,
				truncate(subtask.title, 52),
				getStatusWithColor(subtask.status)
			]);
			console.log(
				boxen(chalk.white.bold(`Обновление подзадачи #${subtaskId}`), {
					padding: 1,
					borderColor: 'blue',
					borderStyle: 'round',
					margin: { top: 1, bottom: 0 }
				})
			);
			console.log(table.toString());
			loadingIndicator = startLoadingIndicator(
				useResearch
					? 'Обновление подзадачи с исследованием...'
					: 'Обновление подзадачи...'
			);
		}

		let generatedContentString = '';
		let newlyAddedSnippet = '';
		let aiServiceResponse = null;

		try {
			const parentContext = {
				id: parentTask.id,
				title: parentTask.title
			};
			const prevSubtask =
				subtaskIndex > 0
					? {
							id: `${parentTask.id}.${parentTask.subtasks[subtaskIndex - 1].id}`,
							title: parentTask.subtasks[subtaskIndex - 1].title,
							status: parentTask.subtasks[subtaskIndex - 1].status
						}
					: null;
			const nextSubtask =
				subtaskIndex < parentTask.subtasks.length - 1
					? {
							id: `${parentTask.id}.${parentTask.subtasks[subtaskIndex + 1].id}`,
							title: parentTask.subtasks[subtaskIndex + 1].title,
							status: parentTask.subtasks[subtaskIndex + 1].status
						}
					: null;

			const contextString = `
Parent Task: ${JSON.stringify(parentContext)}
${prevSubtask ? `Previous Subtask: ${JSON.stringify(prevSubtask)}` : ''}
${nextSubtask ? `Next Subtask: ${JSON.stringify(nextSubtask)}` : ''}
Current Subtask Details (for context only):\n${subtask.details || '(No existing details)'}
`;

			const systemPrompt = `Вы — AI-ассистент, помогающий обновить подзадачу. Вам будут предоставлены существующие детали подзадачи, контекст о ее родительской и соседних задачах, а также строка запроса пользователя.

Ваша цель: основываясь *только* на запросе пользователя и всем предоставленном контексте (включая существующие детали, если они относятся к запросу), СГЕНЕРИРОВАТЬ новое текстовое содержимое, которое должно быть добавлено в детали подзадачи.
Сосредоточьтесь *только* на генерации сути обновления.

Требования к выводу:
1. Возвращайте *только* вновь сгенерированное текстовое содержимое в виде обычной строки. НЕ возвращайте объект JSON или любые другие структурированные данные.
2. Ваш строковый ответ НЕ должен включать никаких исходных деталей подзадачи, если запрос пользователя явно не просит перефразировать, резюмировать или напрямую изменить существующий текст.
3. НЕ включайте никаких временных меток, XML-подобных тегов, markdown или любого другого специального форматирования в ваш строковый ответ.
4. Убедитесь, что сгенерированный текст является кратким, но полным для обновления на основе запроса пользователя. Избегайте разговорных заполнителей или объяснений того, что вы делаете (например, не начинайте с "Хорошо, вот обновление...").`;

			// Pass the existing subtask.details in the user prompt for the AI's context.
			let userPrompt = `Контекст задачи:
${contextString}

Запрос пользователя: "${prompt}"

На основе запроса пользователя и всего контекста задачи (включая текущие детали подзадачи, предоставленные выше), какая новая информация или текст должны быть добавлены в детали этой подзадачи? Возвращайте ТОЛЬКО этот новый текст в виде обычной строки.`

			if (gatheredContext) {
				userPrompt += `\n\n# Additional Project Context\n\n${gatheredContext}`;
			}

			const role = useResearch ? 'research' : 'main';
			report('info', `Использование AI-текстового сервиса с ролью: ${role}`);

			aiServiceResponse = await generateTextService({
				prompt: userPrompt,
				systemPrompt: systemPrompt,
				role,
				session,
				projectRoot,
				maxRetries: 2,
				commandName: 'update-subtask',
				outputType: isMCP ? 'mcp' : 'cli'
			});

			if (
				aiServiceResponse &&
				aiServiceResponse.mainResult &&
				typeof aiServiceResponse.mainResult === 'string'
			) {
				generatedContentString = aiServiceResponse.mainResult;
			} else {
				generatedContentString = '';
				report(
					'warn',
					'Ответ AI-сервиса не содержал ожидаемой текстовой строки.'
				);
			}

			if (outputFormat === 'text' && loadingIndicator) {
				stopLoadingIndicator(loadingIndicator);
				loadingIndicator = null;
			}
		} catch (aiError) {
			report('error', `Вызов AI-сервиса не удался: ${aiError.message}`);
			if (outputFormat === 'text' && loadingIndicator) {
				stopLoadingIndicator(loadingIndicator);
				loadingIndicator = null;
			}
			throw aiError;
		}

		if (generatedContentString && generatedContentString.trim()) {
			// Check if the string is not empty
			const timestamp = new Date().toISOString();
			const formattedBlock = `<info added on ${timestamp}>\n${generatedContentString.trim()}\n</info added on ${timestamp}>`;
			newlyAddedSnippet = formattedBlock; // <--- ADD THIS LINE: Store for display

			subtask.details =
				(subtask.details ? subtask.details + '\n' : '') + formattedBlock;
		} else {
			report(
				'warn',
				'Ответ AI был пустым или содержал только пробелы после обрезки. Исходные детали остаются без изменений.'
			);
			newlyAddedSnippet = 'No new details were added by the AI.';
		}

		const updatedSubtask = parentTask.subtasks[subtaskIndex];

		if (outputFormat === 'text' && getDebugFlag(session)) {
			console.log(
				'>>> DEBUG: Subtask details AFTER AI update:',
				updatedSubtask.details
			);
		}

		if (updatedSubtask.description) {
			if (prompt.length < 100) {
				if (outputFormat === 'text' && getDebugFlag(session)) {
					console.log(
						'>>> DEBUG: Subtask description BEFORE append:',
						updatedSubtask.description
					);
				}
				updatedSubtask.description += ` [Updated: ${new Date().toLocaleDateString()}]`;
				if (outputFormat === 'text' && getDebugFlag(session)) {
					console.log(
						'>>> DEBUG: Subtask description AFTER append:',
						updatedSubtask.description
					);
				}
			}
		}

		if (outputFormat === 'text' && getDebugFlag(session)) {
			console.log('>>> DEBUG: About to call writeJSON with updated data...');
		}
		writeJSON(tasksPath, data, projectRoot, currentTag);
		if (outputFormat === 'text' && getDebugFlag(session)) {
			console.log('>>> DEBUG: writeJSON call completed.');
		}

		report('success', `Подзадача ${subtaskId} успешно обновлена`);
		// await generateTaskFiles(tasksPath, path.dirname(tasksPath));

		if (outputFormat === 'text') {
			if (loadingIndicator) {
				stopLoadingIndicator(loadingIndicator);
				loadingIndicator = null;
			}
			console.log(
				boxen(
					chalk.green(`Подзадача #${subtaskId} успешно обновлена`) +
						'\n\n' +
						chalk.white.bold('Заголовок:') +
						' ' +
						updatedSubtask.title +
						'\n\n' +
						chalk.white.bold('Недавно добавленный фрагмент:') +
						'\n' +
						chalk.white(newlyAddedSnippet),
					{ padding: 1, borderColor: 'green', borderStyle: 'round' }
				)
			);
		}

		if (outputFormat === 'text' && aiServiceResponse.telemetryData) {
			displayAiUsageSummary(aiServiceResponse.telemetryData, 'cli');
		}

		return {
			updatedSubtask: updatedSubtask,
			telemetryData: aiServiceResponse.telemetryData,
			tagInfo: aiServiceResponse.tagInfo
		};
	} catch (error) {
		if (outputFormat === 'text' && loadingIndicator) {
			stopLoadingIndicator(loadingIndicator);
			loadingIndicator = null;
		}
		report('error', `Ошибка обновления подзадачи: ${error.message}`);
		if (outputFormat === 'text') {
			console.error(chalk.red(`Ошибка: ${error.message}`));
			if (error.message?.includes('ANTHROPIC_API_KEY')) {
				console.log(
					chalk.yellow('Чтобы исправить эту проблему, установите свой ключ API Anthropic:')
				);
				console.log('  export ANTHROPIC_API_KEY=your_api_key_here');
			} else if (error.message?.includes('PERPLEXITY_API_KEY')) {
				console.log(chalk.yellow('\nЧтобы исправить эту проблему:'));
				console.log(
					'  1. Set your Perplexity API key: export PERPLEXITY_API_KEY=your_api_key_here'
				);
				console.log(
					'  2. Or run without the research flag: task-master update-subtask --id=<id> --prompt="..."'
				);
			} else if (error.message?.includes('overloaded')) {
				console.log(
					chalk.yellow(
						'\nМодель AI перегружена, и откат не удался или был недоступен:'
					)
				);
				console.log('  1. Try again in a few minutes.');
				console.log('  2. Ensure PERPLEXITY_API_KEY is set for fallback.');
			} else if (error.message?.includes('not found')) {
				console.log(chalk.yellow('\nЧтобы исправить эту проблему:'));
				console.log(
					'  1. Run task-master list --with-subtasks to see all available subtask IDs'
				);
				console.log(
					'  2. Use a valid subtask ID with the --id parameter in format "parentId.subtaskId"'
				);
			} else if (
				error.message?.includes('empty stream response') ||
				error.message?.includes('AI did not return a valid text string')
			) {
				console.log(
					chalk.yellow(
						'\nМодель AI вернула пустой или недействительный ответ. Это может быть связано с промптом или проблемами API. Попробуйте перефразировать или повторить попытку позже.'
					)
				);
			}
			if (getDebugFlag(session)) {
				console.error(error);
			}
		} else {
			throw error;
		}
		return null;
	}
}

export default updateSubtaskById;
