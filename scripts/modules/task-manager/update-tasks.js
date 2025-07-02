import path from 'path';
import chalk from 'chalk';
import boxen from 'boxen';
import Table from 'cli-table3';
import { z } from 'zod'; // Zod оставляем для валидации после парсинга

import {
	log as consoleLog,
	readJSON,
	writeJSON,
	truncate,
	isSilentMode
} from '../utils.js';

import {
	getStatusWithColor,
	startLoadingIndicator,
	stopLoadingIndicator,
	displayAiUsageSummary
} from '../ui.js';

import { getDebugFlag } from '../config-manager.js';
import generateTaskFiles from './generate-task-files.js';
import { generateTextService } from '../ai-services-unified.js';
import { getModelConfiguration } from './models.js';
import { ContextGatherer } from '../utils/contextGatherer.js';
import { FuzzyTaskSearch } from '../utils/fuzzyTaskSearch.js';
import { flattenTasksWithSubtasks, findProjectRoot } from '../utils.js';

// Zod schema for validating the structure of tasks AFTER parsing
const updatedTaskSchema = z
	.object({
		id: z.number().int(),
		title: z.string(),
		description: z.string(),
		status: z.string(),
		dependencies: z.array(z.union([z.number().int(), z.string()])),
		priority: z.string().nullable(),
		details: z.string().nullable(),
		testStrategy: z.string().nullable(),
		subtasks: z.array(z.any()).nullable() // Keep subtasks flexible for now
	})
	.strip(); // Allow potential extra fields during parsing if needed, then validate structure
const updatedTaskArraySchema = z.array(updatedTaskSchema);

/**
 * Parses an array of task objects from AI's text response.
 * @param {string} text - Response text from AI.
 * @param {number} expectedCount - Expected number of tasks.
 * @param {Function | Object} logFn - The logging function or MCP log object.
 * @param {boolean} isMCP - Flag indicating if logFn is MCP logger.
 * @returns {Array} Parsed and validated tasks array.
 * @throws {Error} If parsing or validation fails.
 */
function parseUpdatedTasksFromText(text, expectedCount, logFn, isMCP) {
	const report = (level, ...args) => {
		if (isMCP) {
			if (typeof logFn[level] === 'function') logFn[level](...args);
			else logFn.info(...args);
		} else if (!isSilentMode()) {
			// Check silent mode for consoleLog
			consoleLog(level, ...args);
		}
	};

	report(
		'info',
		'Попытка разобрать массив обновленных задач из текстового ответа...'
	);
	if (!text || text.trim() === '')
		throw new Error('Текст ответа ИИ пуст.');

	let cleanedResponse = text.trim();
	const originalResponseForDebug = cleanedResponse;
	let parseMethodUsed = 'raw'; // Отслеживаем, какой метод сработал

	// --- НОВЫЙ Шаг 1: Сначала пытаемся извлечь содержимое между [] ---
	const firstBracketIndex = cleanedResponse.indexOf('[');
	const lastBracketIndex = cleanedResponse.lastIndexOf(']');
	let potentialJsonFromArray = null;

	if (firstBracketIndex !== -1 && lastBracketIndex > firstBracketIndex) {
		potentialJsonFromArray = cleanedResponse.substring(
			firstBracketIndex,
			lastBracketIndex + 1
		);
		// Базовая проверка, чтобы убедиться, что это не просто "[]" или некорректный формат
		if (potentialJsonFromArray.length <= 2) {
			potentialJsonFromArray = null; // Игнорируем пустой массив
		}
	}

	// If [] extraction yielded something, try parsing it immediately
	if (potentialJsonFromArray) {
		try {
			const testParse = JSON.parse(potentialJsonFromArray);
			// Сработало! Используем это как основной очищенный ответ.
			cleanedResponse = potentialJsonFromArray;
			parseMethodUsed = 'brackets';
		} catch (e) {
			report(
				'info',
				'Содержимое между [] выглядело многообещающе, но не прошло первичный разбор. Переход к другим методам.'
			);
			// Сбрасываем cleanedResponse к исходному, если парсинг скобок не удался
			cleanedResponse = originalResponseForDebug;
		}
	}

	// --- Шаг 2: Если парсинг скобок не сработал или неприменим, пытаемся извлечь блок кода ---
	if (parseMethodUsed === 'raw') {
		// Ищем только блоки ```json
		const codeBlockMatch = cleanedResponse.match(
			/```json\s*([\s\S]*?)\s*```/i // Ищем только ```json
		);
		if (codeBlockMatch) {
			cleanedResponse = codeBlockMatch[1].trim();
			parseMethodUsed = 'codeblock';
			report('info', 'Извлечено содержимое JSON из блока кода Markdown.');
		} else {
			report('info', 'Блок кода JSON не найден.');
			// --- Шаг 3: Если извлечение блока кода не удалось, пытаемся удалить префиксы ---
			const commonPrefixes = [
				'json\n',
				'javascript\n', // Продолжаем проверять общие префиксы на всякий случай
				'python\n',
				'here are the updated tasks:',
				'here is the updated json:',
				'updated tasks:',
				'updated json:',
				'response:',
				'output:'
			];
			let prefixFound = false;
			for (const prefix of commonPrefixes) {
				if (cleanedResponse.toLowerCase().startsWith(prefix)) {
					cleanedResponse = cleanedResponse.substring(prefix.length).trim();
					parseMethodUsed = 'prefix';
					report('info', `Удален префикс: "${prefix.trim()}"`);
					prefixFound = true;
					break;
				}
			}
			if (!prefixFound) {
				report(
					'warn',
					'Ответ, похоже, не содержит [], блока кода JSON или известного префикса. Попытка необработанного разбора.'
				);
			}
		}
	}

	// --- Шаг 4: Попытка финального парсинга ---
	let parsedTasks;
	try {
		parsedTasks = JSON.parse(cleanedResponse);
	} catch (parseError) {
		report('error', `Не удалось разобрать массив JSON: ${parseError.message}`);
		report(
			'error',
			`Использованный метод извлечения: ${parseMethodUsed}` // Логируем, какой метод не сработал
		);
		report(
			'error',
			`Проблемная строка JSON (первые 500 символов): ${cleanedResponse.substring(0, 500)}`
		);
		report(
			'error',
			`Исходный необработанный ответ (первые 500 символов): ${originalResponseForDebug.substring(0, 500)}`
		);
		throw new Error(
			`Не удалось разобрать массив ответа JSON: ${parseError.message}`
		);
	}

	// --- Шаг 5 и 6: Валидация структуры массива и схемы Zod ---
	if (!Array.isArray(parsedTasks)) {
		report(
			'error',
			`Разобранное содержимое не является массивом. Тип: ${typeof parsedTasks}`
		);
		report(
			'error',
			`Пример разобранного содержимого: ${JSON.stringify(parsedTasks).substring(0, 200)}`
		);
		throw new Error('Разобранный ответ ИИ не является валидным массивом JSON.');
	}

	report('info', `Успешно разобрано ${parsedTasks.length} потенциальных задач.`);
	if (expectedCount && parsedTasks.length !== expectedCount) {
		report(
			'warn',
			`Ожидалось ${expectedCount} задач, но разобрано ${parsedTasks.length}.`
		);
	}

	const validationResult = updatedTaskArraySchema.safeParse(parsedTasks);
	if (!validationResult.success) {
		report('error', 'Разобранный массив задач не прошел валидацию Zod.');
		validationResult.error.errors.forEach((err) => {
			report('error', `  - Путь '${err.path.join('.')}}': ${err.message}`);
		});
		throw new Error(
			`Ответ ИИ не прошел валидацию структуры задачи: ${validationResult.error.message}`
		);
	}

	report('info', 'Структура задачи успешно прошла валидацию.');
	return validationResult.data.slice(
		0,
		expectedCount || validationResult.data.length
	);
}

/**
 * Update tasks based on new context using the unified AI service.
 * @param {string} tasksPath - Path to the tasks.json file
 * @param {number} fromId - Task ID to start updating from
 * @param {string} prompt - Prompt with new context
 * @param {boolean} [useResearch=false] - Whether to use the research AI role.
 * @param {Object} context - Context object containing session and mcpLog.
 * @param {Object} [context.session] - Session object from MCP server.
 * @param {Object} [context.mcpLog] - MCP logger object.
 * @param {string} [outputFormat='text'] - Output format ('text' or 'json').
 */
async function updateTasks(
	tasksPath,
	fromId,
	prompt,
	useResearch = false,
	context = {},
	outputFormat = 'text' // По умолчанию текст для CLI
) {
	const { session, mcpLog, projectRoot: providedProjectRoot } = context;
	// Используем mcpLog, если доступен, иначе используем импортированную функцию consoleLog
	const logFn = mcpLog || consoleLog;
	// Флаг для простой проверки типа логгера
	const isMCP = !!mcpLog;

	if (isMCP)
		logFn.info(`updateTasks вызван с контекстом: session=${!!session}`);
	else logFn('info', `updateTasks вызван`); // Лог CLI

	try {
		if (isMCP) logFn.info(`Обновление задач с ID ${fromId}`);
		else
			logFn(
				'info',
				`Обновление задач с ID ${fromId} с промптом: "${prompt}"`
			);

		// Определяем корень проекта
		const projectRoot = providedProjectRoot || findProjectRoot();
		if (!projectRoot) {
			throw new Error('Не удалось определить корневой каталог проекта');
		}

		// --- Загрузка/фильтрация задач (без изменений) ---
		const data = readJSON(tasksPath, projectRoot);
		if (!data || !data.tasks)
			throw new Error(`В файле ${tasksPath} не найдено валидных задач`);
		const tasksToUpdate = data.tasks.filter(
			(task) => task.id >= fromId && task.status !== 'done'
		);
		if (tasksToUpdate.length === 0) {
			if (isMCP)
				logFn.info(`Нет задач для обновления (ID >= ${fromId} и не 'done').`);
			else
				logFn('info', `Нет задач для обновления (ID >= ${fromId} и не 'done').`);
			return; // Нечего делать
		}
		// --- Конец загрузки/фильтрации задач ---

		// --- Сбор контекста ---
		let gatheredContext = '';
		try {
			const contextGatherer = new ContextGatherer(projectRoot);
			const allTasksFlat = flattenTasksWithSubtasks(data.tasks);
			const fuzzySearch = new FuzzyTaskSearch(allTasksFlat, 'update');
			const searchResults = fuzzySearch.findRelevantTasks(prompt, {
				maxResults: 5,
				includeSelf: true
			});
			const relevantTaskIds = fuzzySearch.getTaskIds(searchResults);

			const tasksToUpdateIds = tasksToUpdate.map((t) => t.id.toString());
			const finalTaskIds = [
				...new Set([...tasksToUpdateIds, ...relevantTaskIds])
			];

			if (finalTaskIds.length > 0) {
				const contextResult = await contextGatherer.gather({
					tasks: finalTaskIds,
					format: 'research'
				});
				gatheredContext = contextResult; // contextResult - это строка
			}
		} catch (contextError) {
			logFn(
				'warn',
				`Не удалось собрать дополнительный контекст: ${contextError.message}`
			);
		}
		// --- Конец сбора контекста ---

		// --- Отображение задач для обновления (только CLI - без изменений) ---
		if (outputFormat === 'text') {
			// Показываем задачи, которые будут обновлены
			const table = new Table({
				head: [
					chalk.cyan.bold('ID'),
					chalk.cyan.bold('Название'),
					chalk.cyan.bold('Статус')
				],
				colWidths: [5, 70, 20]
			});

			tasksToUpdate.forEach((task) => {
				table.push([
					task.id,
					truncate(task.title, 57),
					getStatusWithColor(task.status)
				]);
			});

			console.log(
				boxen(chalk.white.bold(`Обновление ${tasksToUpdate.length} задач`), {
					padding: 1,
					borderColor: 'blue',
					borderStyle: 'round',
					margin: { top: 1, bottom: 0 }
				})
			);

			console.log(table.toString());

			// Отображаем сообщение о том, как обрабатываются выполненные подзадачи
			console.log(
				boxen(
					chalk.cyan.bold('Как обрабатываются выполненные подзадачи:') +
						'\n\n' +
						chalk.white(
							'• Подзадачи, помеченные как "done" или "completed", будут сохранены\n'
						) +
						chalk.white(
							'• Новые подзадачи будут создаваться на основе уже выполненных\n'
						) +
						chalk.white(
							'• Если выполненную работу нужно пересмотреть, будет создана новая подзадача, а не изменены существующие\n'
						) +
						chalk.white(
							'• Такой подход обеспечивает четкий учет выполненной работы и новых требований'
						),
					{
						padding: 1,
						borderColor: 'blue',
						borderStyle: 'round',
						margin: { top: 1, bottom: 1 }
					}
				)
			);
		}
		// --- Конец отображения задач ---

		// --- Создание промптов (без изменений основной логики) ---
		// Сохраняем исходную логику системного промпта
		const systemPrompt = `Вы — ИИ-ассистент, помогающий обновлять задачи по разработке программного обеспечения на основе нового контекста.\nВам будет предоставлен набор задач и промпт, описывающий изменения или новые детали реализации.\nВаша задача — обновить задачи, чтобы отразить эти изменения, сохранив при этом их базовую структуру.\n\nРекомендации:\n1. Сохраняйте те же ID, статусы и зависимости, если это специально не указано в промпте\n2. Обновите названия, описания, детали и стратегии тестирования, чтобы отразить новую информацию\n3. Не меняйте ничего без необходимости — адаптируйте только то, что нужно изменить на основе промпта\n4. Вы должны вернуть ВСЕ задачи по порядку, а не только измененные\n5. Верните полный валидный объект JSON с обновленным массивом задач\n6. ОЧЕНЬ ВАЖНО: Сохраняйте все подзадачи, помеченные как "done" или "completed" — не изменяйте их содержимое\n7. Для задач с выполненными подзадачами основывайтесь на том, что уже сделано, а не переписывайте все заново\n8. Если существующую выполненную подзадачу необходимо изменить/отменить на основе нового контекста, НЕ изменяйте ее напрямую\n9. Вместо этого добавьте новую подзадачу, которая четко указывает, что необходимо изменить или заменить\n10. Используйте наличие выполненных подзадач как возможность сделать новые подзадачи более конкретными и целенаправленными\n\nИзменения, описанные в промпте, должны быть применены ко ВСЕМ задачам в списке.`;

		// Сохраняем исходную логику пользовательского промпта
		const taskDataString = JSON.stringify(tasksToUpdate, null, 2);
		let userPrompt = `Вот задачи для обновления:\n${taskDataString}\n\nПожалуйста, обновите эти задачи на основе следующего нового контекста:\n${prompt}\n\nВАЖНО: В приведенном выше JSON задач любые подзадачи со статусом "done" или "completed" должны быть сохранены в точности как есть. Стройте свои изменения вокруг этих выполненных элементов.`;

		if (gatheredContext) {
			userPrompt += `\n\n# Контекст проекта\n\n${gatheredContext}`;
		}

		userPrompt += `\n\nВерните только обновленные задачи в виде валидного массива JSON.`;
		// --- Конец создания промптов ---

		// --- Вызов ИИ ---
		let loadingIndicator = null;
		let aiServiceResponse = null;

		if (!isMCP && outputFormat === 'text') {
			loadingIndicator = startLoadingIndicator('Обновление задач с помощью ИИ...\n');
		}

		try {
			// Определяем роль на основе флага research
			const serviceRole = useResearch ? 'research' : 'main';

			// Вызываем унифицированный сервис ИИ
			aiServiceResponse = await generateTextService({
				role: serviceRole,
				session: session,
				projectRoot: projectRoot,
				systemPrompt: systemPrompt,
				prompt: userPrompt,
				commandName: 'update-tasks',
				outputType: isMCP ? 'mcp' : 'cli'
			});

			if (loadingIndicator)
				stopLoadingIndicator(loadingIndicator, 'Обновление ИИ завершено.');

			// Используем mainResult (текст) для парсинга
			const parsedUpdatedTasks = parseUpdatedTasksFromText(
				aiServiceResponse.mainResult,
				tasksToUpdate.length,
				logFn,
				isMCP
			);

			// --- Обновление данных задач (без изменений) ---
			if (!Array.isArray(parsedUpdatedTasks)) {
				// Должно быть перехвачено парсером, но дополнительная проверка
				throw new Error(
					'Разобранный ответ ИИ для обновленных задач не был массивом.'
				);
			}
			if (isMCP)
				logFn.info(
					`Получено ${parsedUpdatedTasks.length} обновленных задач от ИИ.`
				);
			else
				logFn(
					'info',
					`Получено ${parsedUpdatedTasks.length} обновленных задач от ИИ.`
				);
			// Создаем карту для эффективного поиска
			const updatedTasksMap = new Map(
				parsedUpdatedTasks.map((task) => [task.id, task])
			);

			let actualUpdateCount = 0;
			data.tasks.forEach((task, index) => {
				if (updatedTasksMap.has(task.id)) {
					// Обновляем только если задача была частью набора, отправленного ИИ
					data.tasks[index] = updatedTasksMap.get(task.id);
					actualUpdateCount++;
				}
			});
			if (isMCP)
				logFn.info(
					`Применено обновлений к ${actualUpdateCount} задачам в наборе данных.`
				);
			else
				logFn(
					'info',
					`Применено обновлений к ${actualUpdateCount} задачам в наборе данных.`
				);

			writeJSON(tasksPath, data);
			if (isMCP)
				logFn.info(
					`Успешно обновлено ${actualUpdateCount} задач в ${tasksPath}`
				);
			else
				logFn(
					'success',
					`Успешно обновлено ${actualUpdateCount} задач в ${tasksPath}`
				);
			// await generateTaskFiles(tasksPath, path.dirname(tasksPath));

			if (outputFormat === 'text' && aiServiceResponse.telemetryData) {
				displayAiUsageSummary(aiServiceResponse.telemetryData, 'cli');
			}

			return {
				success: true,
				updatedTasks: parsedUpdatedTasks,
				telemetryData: aiServiceResponse.telemetryData,
				tagInfo: aiServiceResponse.tagInfo
			};
		} catch (error) {
			if (loadingIndicator) stopLoadingIndicator(loadingIndicator);
			if (isMCP) logFn.error(`Ошибка во время вызова сервиса ИИ: ${error.message}`);
			else logFn('error', `Ошибка во время вызова сервиса ИИ: ${error.message}`);
			if (error.message.includes('API key')) {
				if (isMCP)
					logFn.error(
						'Пожалуйста, убедитесь, что ключи API настроены правильно в .env или mcp.json.'
					);
				else
					logFn(
						'error',
						'Пожалуйста, убедитесь, что ключи API настроены правильно в .env или mcp.json.'
					);
			}
			throw error;
		} finally {
			if (loadingIndicator) stopLoadingIndicator(loadingIndicator);
		}
	} catch (error) {
		// --- Общая обработка ошибок (без изменений) ---
		if (isMCP) logFn.error(`Ошибка при обновлении задач: ${error.message}`);
		else logFn('error', `Ошибка при обновлении задач: ${error.message}`);
		if (outputFormat === 'text') {
			console.error(chalk.red(`Ошибка: ${error.message}`));
			if (getDebugFlag(session)) {
				console.error(error);
			}
			process.exit(1);
		} else {
			throw error; // Повторно выбрасываем для MCP/программных вызывающих сторон
		}
		// --- Конец общей обработки ошибок ---
	}
}

export { updateTasks };