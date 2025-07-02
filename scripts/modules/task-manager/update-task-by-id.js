import fs from 'fs';
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
	isSilentMode,
	flattenTasksWithSubtasks,
	findProjectRoot,
	getCurrentTag
} from '../utils.js';

import {
	getStatusWithColor,
	startLoadingIndicator,
	stopLoadingIndicator,
	displayAiUsageSummary
} from '../ui.js';

import { generateTextService } from '../ai-services-unified.js';
import { getDebugFlag, isApiKeySet } from '../config-manager.js';
import { ContextGatherer } from '../utils/contextGatherer.js';
import { FuzzyTaskSearch } from '../utils/fuzzyTaskSearch.js';

// Zod schema for post-parsing validation of the updated task object
const updatedTaskSchema = z
	.object({
		id: z.number().int(),
		title: z.string(), // Title should be preserved, but check it exists
		description: z.string(),
		status: z.string(),
		dependencies: z.array(z.union([z.number().int(), z.string()])),
		priority: z.string().nullable().default('medium'),
		details: z.string().nullable().default(''),
		testStrategy: z.string().nullable().default(''),
		subtasks: z
			.array(
				z.object({
					id: z
						.number()
						.int()
						.positive()
						.describe('Последовательный ID подзадачи, начиная с 1'),
					title: z.string(),
					description: z.string(),
					status: z.string(),
					dependencies: z.array(z.number().int()).nullable().default([]),
					details: z.string().nullable().default(''),
					testStrategy: z.string().nullable().default('')
				})
			)
			.nullable()
			.default([])
	})
	.strip(); // Позволяет парсинг, даже если ИИ добавляет лишние поля, но валидация фокусируется на схеме

/**
 * Parses a single updated task object from AI's text response.
 * @param {string} text - Response text from AI.
 * @param {number} expectedTaskId - The ID of the task expected.
 * @param {Function | Object} logFn - Logging function or MCP logger.
 * @param {boolean} isMCP - Flag indicating MCP context.
 * @returns {Object} Parsed and validated task object.
 * @throws {Error} If parsing or validation fails.
 */
function parseUpdatedTaskFromText(text, expectedTaskId, logFn, isMCP) {
	// Вспомогательная функция для отчетов, соответствующая установленному шаблону
	const report = (level, ...args) => {
		if (isMCP) {
			if (typeof logFn[level] === 'function') logFn[level](...args);
			else logFn.info(...args);
		} else if (!isSilentMode()) {
			logFn(level, ...args);
		}
	};

	report(
		'info',
		'Попытка разобрать обновленный объект задачи из текстового ответа...'
	);
	if (!text || text.trim() === '')
		throw new Error('Текст ответа ИИ пуст.');

	let cleanedResponse = text.trim();
	const originalResponseForDebug = cleanedResponse;
	let parseMethodUsed = 'raw'; // Отслеживаем, какой метод сработал

	// --- НОВЫЙ Шаг 1: Сначала пытаемся извлечь содержимое между {} ---
	const firstBraceIndex = cleanedResponse.indexOf('{');
	const lastBraceIndex = cleanedResponse.lastIndexOf('}');
	let potentialJsonFromBraces = null;

	if (firstBraceIndex !== -1 && lastBraceIndex > firstBraceIndex) {
		potentialJsonFromBraces = cleanedResponse.substring(
			firstBraceIndex,
			lastBraceIndex + 1
		);
		if (potentialJsonFromBraces.length <= 2) {
			potentialJsonFromBraces = null; // Игнорируем пустые скобки {}
		}
	}

	// If {} extraction yielded something, try parsing it immediately
	if (potentialJsonFromBraces) {
		try {
			const testParse = JSON.parse(potentialJsonFromBraces);
			// Сработало! Используем это как основной очищенный ответ.
			cleanedResponse = potentialJsonFromBraces;
			parseMethodUsed = 'braces';
		} catch (e) {
			report(
				'info',
				'Содержимое между {} выглядело многообещающе, но не прошло первичный разбор. Переход к другим методам.'
			);
			// Сбрасываем cleanedResponse к исходному, если парсинг скобок не удался
			cleanedResponse = originalResponseForDebug;
		}
	}

	// --- Шаг 2: Если парсинг скобок не сработал или неприменим, пытаемся извлечь блок кода ---
	if (parseMethodUsed === 'raw') {
		const codeBlockMatch = cleanedResponse.match(
			/```(?:json|javascript)?\s*([\s\S]*?)\s*```/i
		);
		if (codeBlockMatch) {
			cleanedResponse = codeBlockMatch[1].trim();
			parseMethodUsed = 'codeblock';
			report('info', 'Извлечено содержимое JSON из блока кода Markdown.');
		} else {
			// --- Шаг 3: Если извлечение блока кода не удалось, пытаемся удалить префиксы ---
			const commonPrefixes = [
				'json\n',
				'javascript\n'
				// ... other prefixes ...
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
					'Ответ, похоже, не содержит {}, блока кода или известного префикса. Попытка необработанного разбора.'
				);
			}
		}
	}

	// --- Шаг 4: Попытка финального парсинга ---
	let parsedTask;
	try {
		parsedTask = JSON.parse(cleanedResponse);
	} catch (parseError) {
		report('error', `Не удалось разобрать объект JSON: ${parseError.message}`);
		report(
			'error',
			`Проблемная строка JSON (первые 500 символов): ${cleanedResponse.substring(0, 500)}`
		);
		report(
			'error',
			`Исходный необработанный ответ (первые 500 символов): ${originalResponseForDebug.substring(0, 500)}`
		);
		throw new Error(
			`Не удалось разобрать объект ответа JSON: ${parseError.message}`
		);
	}

	if (!parsedTask || typeof parsedTask !== 'object') {
		report(
			'error',
			`Разобранное содержимое не является объектом. Тип: ${typeof parsedTask}`
		);
		report(
			'error',
			`Образец разобранного содержимого: ${JSON.stringify(parsedTask).substring(0, 200)}`
		);
		throw new Error('Разобранный ответ ИИ не является действительным объектом JSON.');
	}

	// Валидируем разобранный объект задачи с помощью Zod
	const validationResult = updatedTaskSchema.safeParse(parsedTask);
	if (!validationResult.success) {
		report('error', 'Разобранный объект задачи не прошел валидацию Zod.');
		validationResult.error.errors.forEach((err) => {
			report('error', `  - Поле '${err.path.join('.')}}': ${err.message}`);
		});
		throw new Error(
			`Ответ ИИ не прошел валидацию структуры задачи: ${validationResult.error.message}`
		);
	}

	// Финальная проверка: убеждаемся, что ID совпадает с ожидаемым (ИИ может галлюцинировать)
	if (validationResult.data.id !== expectedTaskId) {
		report(
			'warn',
			`ИИ изменил ID задачи. Восстановление исходного ID ${expectedTaskId}.`
		);
		validationResult.data.id = expectedTaskId; // Принудительно устанавливаем правильный ID
	}

	report('info', 'Структура обновленной задачи успешно прошла валидацию.');
	return validationResult.data; // Возвращаем валидированные данные задачи
}

/**
 * Update a task by ID with new information using the unified AI service.
 * @param {string} tasksPath - Path to the tasks.json file
 * @param {number} taskId - ID of the task to update
 * @param {string} prompt - Prompt for generating updated task information
 * @param {boolean} [useResearch=false] - Whether to use the research AI role.
 * @param {Object} context - Context object containing session and mcpLog.
 * @param {Object} [context.session] - Session object from MCP server.
 * @param {Object} [context.mcpLog] - MCP logger object.
 * @param {string} [context.projectRoot] - Project root path.
 * @param {string} [outputFormat='text'] - Output format ('text' or 'json').
 * @param {boolean} [appendMode=false] - If true, append to details instead of full update.
 * @returns {Promise<Object|null>} - The updated task or null if update failed.
 */
async function updateTaskById(
	tasksPath,
	taskId,
	prompt,
	useResearch = false,
	context = {},
	outputFormat = 'text',
	appendMode = false
) {
	const { session, mcpLog, projectRoot: providedProjectRoot, tag } = context;
	const logFn = mcpLog || consoleLog;
	const isMCP = !!mcpLog;

	// Use report helper for logging
	const report = (level, ...args) => {
		if (isMCP) {
			if (typeof logFn[level] === 'function') logFn[level](...args);
			else logFn.info(...args);
		} else if (!isSilentMode()) {
			logFn(level, ...args);
		}
	};

	try {
		report('info', `Обновление одной задачи ${taskId} с промптом: "${prompt}"`);

		// --- Валидация входных данных (оставляем существующую) ---
		if (!Number.isInteger(taskId) || taskId <= 0)
			throw new Error(
				`Неверный ID задачи: ${taskId}. ID задачи должен быть положительным целым числом.`
			);
		if (!prompt || typeof prompt !== 'string' || prompt.trim() === '')
			throw new Error('Промпт не может быть пустым.');
		if (useResearch && !isApiKeySet('perplexity', session)) {
			report(
				'warn',
				'Запрошено исследование Perplexity, но ключ API не установлен. Используется запасной вариант.'
			);
			if (outputFormat === 'text')
				console.log(
					chalk.yellow('ИИ Perplexity недоступен. Переключение на основной ИИ.')
				);
			useResearch = false;
		}
		if (!fs.existsSync(tasksPath))
			throw new Error(`Файл задач не найден: ${tasksPath}`);
		// --- Конец валидации входных данных ---

		// Определяем корень проекта
		const projectRoot = providedProjectRoot || findProjectRoot();
		if (!projectRoot) {
			throw new Error('Не удалось определить корневой каталог проекта');
		}

		// Определяем тег для использования
		const currentTag = tag || getCurrentTag(projectRoot) || 'master';

		// --- Загрузка задачи и проверка статуса (оставляем существующую) ---
		const data = readJSON(tasksPath, projectRoot, currentTag);
		if (!data || !data.tasks)
			throw new Error(`В файле ${tasksPath} не найдено валидных задач.`);
		const taskIndex = data.tasks.findIndex((task) => task.id === taskId);
		if (taskIndex === -1) throw new Error(`Задача с ID ${taskId} не найдена.`);
		const taskToUpdate = data.tasks[taskIndex];
		if (taskToUpdate.status === 'done' || taskToUpdate.status === 'completed') {
			report(
				'warn',
				`Задача ${taskId} уже помечена как выполненная и не может быть обновлена`
			);

			// Показываем предупреждение только для текстового вывода (CLI)
			if (outputFormat === 'text') {
				console.log(
					boxen(
						chalk.yellow(
							`Задача ${taskId} уже помечена как ${taskToUpdate.status} и не может быть обновлена.`
						) +
							'\n\n' +
							chalk.white(
								'Выполненные задачи заблокированы для сохранения целостности. Чтобы изменить выполненную задачу, вы должны сначала:'
							) +
							'\n' +
							chalk.white(
								'1. Изменить ее статус на "pending" или "in-progress"'
							) +
							'\n' +
							chalk.white('2. Затем выполнить команду update-task'),
						{
							padding: 1,
							borderColor: 'yellow',
							borderStyle: 'round'
						}
					)
				);
			}
			return null;
		}
		// --- Конец загрузки задачи ---

		// --- Сбор контекста ---
		let gatheredContext = '';
		try {
			const contextGatherer = new ContextGatherer(projectRoot);
			const allTasksFlat = flattenTasksWithSubtasks(data.tasks);
			const fuzzySearch = new FuzzyTaskSearch(allTasksFlat, 'update-task');
			const searchQuery = `${taskToUpdate.title} ${taskToUpdate.description} ${prompt}`;
			const searchResults = fuzzySearch.findRelevantTasks(searchQuery, {
				maxResults: 5,
				includeSelf: true
			});
			const relevantTaskIds = fuzzySearch.getTaskIds(searchResults);

			const finalTaskIds = [
				...new Set([taskId.toString(), ...relevantTaskIds])
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
		// --- Конец сбора контекста ---

		// --- Отображение информации о задаче (только CLI - оставляем существующее) ---
		if (outputFormat === 'text') {
			// Показываем задачу, которая будет обновлена
			const table = new Table({
				head: [
					chalk.cyan.bold('ID'),
					chalk.cyan.bold('Название'),
					chalk.cyan.bold('Статус')
				],
				colWidths: [5, 60, 10]
			});

			table.push([
				taskToUpdate.id,
				truncate(taskToUpdate.title, 57),
				getStatusWithColor(taskToUpdate.status)
			]);

			console.log(
				boxen(chalk.white.bold(`Обновление задачи #${taskId}`), {
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

		// --- Создание промптов (разные для добавления и полного обновления) ---
		let systemPrompt;
		let userPrompt;

		if (appendMode) {
			// Режим добавления: генерируем новый контент для добавления в детали задачи
			systemPrompt = `Вы — ИИ-ассистент, помогающий добавлять дополнительную информацию к задаче по разработке программного обеспечения. Вам будут предоставлены существующие детали задачи, контекст и строка запроса пользователя.\n\nВаша цель: Основываясь *только* на запросе пользователя и всем предоставленном контексте (включая существующие детали, если они имеют отношение к запросу), СГЕНЕРИРУЙТЕ новый текстовый контент, который следует добавить в детали задачи.\nСосредоточьтесь *только* на генерации сути обновления.\n\nТребования к выводу:\n1. Возвращайте *только* вновь сгенерированный текстовый контент в виде простой строки. НЕ возвращайте объект JSON или любые другие структурированные данные.\n2. Ваш строковый ответ НЕ должен включать никаких исходных деталей задачи, если только запрос пользователя явно не просит перефразировать, обобщить или напрямую изменить существующий текст.\n3. НЕ включайте в свой строковый ответ никаких временных меток, XML-подобных тегов, markdown или любого другого специального форматирования.\n4. Убедитесь, что сгенерированный текст является кратким, но полным для обновления на основе запроса пользователя. Избегайте разговорных наполнителей или объяснений того, что вы делаете (например, не начинайте с "Хорошо, вот обновление...").`;

			const taskContext = `\nTask: ${JSON.stringify({
				id: taskToUpdate.id,
				title: taskToUpdate.title,
				description: taskToUpdate.description,
				status: taskToUpdate.status
			})}\nТекущие детали задачи (только для контекста):\n${taskToUpdate.details || '(Нет существующих деталей)'}\n`;

			userPrompt = `Контекст задачи:\n${taskContext}\n\nЗапрос пользователя: "${prompt}"\n\nОсновываясь на запросе пользователя и всем контексте задачи (включая текущие детали задачи, представленные выше), какую новую информацию или текст следует добавить в детали этой задачи? Верните ТОЛЬКО этот новый текст в виде простой строки.`;

			if (gatheredContext) {
				userPrompt += `\n\n# Дополнительный контекст проекта\n\n${gatheredContext}`;
			}
		} else {
			// Режим полного обновления: используем исходные промпты
			systemPrompt = `Вы — ИИ-ассистент, помогающий обновлять задачу по разработке программного обеспечения на основе нового контекста.\nВам будет дана задача и промпт, описывающий изменения или новые детали реализации.\nВаша задача — обновить задачу, чтобы отразить эти изменения, сохранив при этом ее базовую структуру.\n\nРекомендации:\n1. ОЧЕНЬ ВАЖНО: НИКОГДА не меняйте название задачи — оставляйте его в точности как есть\n2. Сохраняйте те же ID, статус и зависимости, если это специально не указано в промпте\n3. Обновите описание, детали и стратегию тестирования, чтобы отразить новую информацию\n4. Не меняйте ничего без необходимости — адаптируйте только то, что нужно изменить на основе промпта\n5. Верните полный валидный объект JSON, представляющий обновленную задачу\n6. ОЧЕНЬ ВАЖНО: Сохраняйте все подзадачи, помеченные как "done" или "completed" — не изменяйте их содержимое\n7. Для задач с выполненными подзадачами основывайтесь на том, что уже сделано, а не переписывайте все заново\n8. Если существующую выполненную подзадачу необходимо изменить/отменить на основе нового контекста, НЕ изменяйте ее напрямую\n9. Вместо этого добавьте новую подзадачу, которая четко указывает, что необходимо изменить или заменить\n10. Используйте наличие выполненных подзадач как возможность сделать новые подзадачи более конкретными и целенаправленными\n11. Убедитесь, что у любых новых подзадач есть уникальные ID, которые не конфликтуют с существующими\n12. КРИТИЧЕСКИ ВАЖНО: Для ID подзадач используйте ТОЛЬКО числовые значения (1, 2, 3 и т. д.), а НЕ строки ("1", "2", "3")\n13. КРИТИЧЕСКИ ВАЖНО: ID подзадач должны начинаться с 1 и увеличиваться последовательно (1, 2, 3...) — НЕ используйте ID родительской задачи в качестве префикса\n\nИзменения, описанные в промпте, должны быть вдумчиво применены, чтобы сделать задачу более точной и действенной.`;

			const taskDataString = JSON.stringify(taskToUpdate, null, 2);
			userPrompt = `Вот задача для обновления:\n${taskDataString}\n\nПожалуйста, обновите эту задачу на основе следующего нового контекста:\n${prompt}\n\nВАЖНО: В приведенном выше JSON задачи любые подзадачи со статусом "done" или "completed" должны быть сохранены в точности как есть. Стройте свои изменения вокруг этих выполненных элементов.`;

			if (gatheredContext) {
				userPrompt += `\n\n# Контекст проекта\n\n${gatheredContext}`;
			}

			userPrompt += `\n\nВерните только обновленную задачу в виде валидного объекта JSON.`;
		}
		// --- Конец создания промптов ---

		let loadingIndicator = null;
		let aiServiceResponse = null;

		if (!isMCP && outputFormat === 'text') {
			loadingIndicator = startLoadingIndicator(
				useResearch ? 'Обновление задачи с исследованием...\n' : 'Обновление задачи...\n'
			);
		}

		try {
			const serviceRole = useResearch ? 'research' : 'main';
			aiServiceResponse = await generateTextService({
				role: serviceRole,
				session: session,
				projectRoot: projectRoot,
				systemPrompt: systemPrompt,
				prompt: userPrompt,
				commandName: 'update-task',
				outputType: isMCP ? 'mcp' : 'cli'
			});

			if (loadingIndicator)
				stopLoadingIndicator(loadingIndicator, 'Обновление ИИ завершено.');

			if (appendMode) {
				// Режим добавления: обрабатываем как обычный текст
				const generatedContentString = aiServiceResponse.mainResult;
				let newlyAddedSnippet = '';

				if (generatedContentString && generatedContentString.trim()) {
					const timestamp = new Date().toISOString();
					const formattedBlock = `<info добавлено ${timestamp}>\n${generatedContentString.trim()}\n</info добавлено ${timestamp}>`;
					newlyAddedSnippet = formattedBlock;

					// Append to task details
					taskToUpdate.details =
						(taskToUpdate.details ? taskToUpdate.details + '\n' : '') +
						formattedBlock;
				} else {
					report(
						'warn',
						'Ответ ИИ был пустым или состоял из пробелов после обрезки. Исходные детали остаются без изменений.'
					);
					newlyAddedSnippet = 'ИИ не добавил новых деталей.';
				}

				// Обновляем описание с временной меткой, если промпт короткий
				if (prompt.length < 100) {
					if (taskToUpdate.description) {
						taskToUpdate.description += ` [Обновлено: ${new Date().toLocaleDateString()}]`;
					}
				}

				// Записываем обновленную задачу обратно в файл
				data.tasks[taskIndex] = taskToUpdate;
				writeJSON(tasksPath, data, projectRoot, currentTag);
				report('success', `Успешно добавлено в задачу ${taskId}`);

				// Отображаем сообщение об успехе для CLI
				if (outputFormat === 'text') {
					console.log(
						boxen(
							chalk.green(`Успешно добавлено в задачу #${taskId}`) +
								'\n\n' +
								chalk.white.bold('Название:') +
								' ' +
								taskToUpdate.title +
								'\n\n' +
								chalk.white.bold('Новый добавленный контент:') +
								'\n' +
								chalk.white(newlyAddedSnippet),
							{
								padding: 1,
								borderColor: 'green',
								borderStyle: 'round'
							}
						)
					);
				}

				// Отображаем телеметрию использования ИИ для пользователей CLI
				if (outputFormat === 'text' && aiServiceResponse.telemetryData) {
					displayAiUsageSummary(aiServiceResponse.telemetryData, 'cli');
				}

				// Возвращаем обновленную задачу
				return {
					updatedTask: taskToUpdate,
					telemetryData: aiServiceResponse.telemetryData,
					tagInfo: aiServiceResponse.tagInfo
				};
			}

			// Режим полного обновления: используем mainResult (текст) для парсинга
			const updatedTask = parseUpdatedTaskFromText(
				aiServiceResponse.mainResult,
				taskId,
				logFn,
				isMCP
			);

			// --- Валидация/коррекция задачи (оставляем существующую логику) ---
			if (!updatedTask || typeof updatedTask !== 'object')
				throw new Error('От ИИ получен неверный объект задачи.');
			if (!updatedTask.title || !updatedTask.description)
				throw new Error('В обновленной задаче отсутствуют обязательные поля.');
			// Сохраняем ID, если ИИ его изменил
			if (updatedTask.id !== taskId) {
				report('warn', `ИИ изменил ID задачи. Восстанавливаем исходный ID ${taskId}.`);
				updatedTask.id = taskId;
			}
			// Сохраняем статус, если ИИ его изменил
			if (
				updatedTask.status !== taskToUpdate.status &&
				!prompt.toLowerCase().includes('status')
			) {
				report(
					'warn',
					`ИИ изменил статус задачи. Восстанавливаем исходный статус '${taskToUpdate.status}'.`
				);
				updatedTask.status = taskToUpdate.status;
			}
			// Исправляем ID подзадач, если они существуют (убеждаемся, что они числовые и последовательные)
			if (updatedTask.subtasks && Array.isArray(updatedTask.subtasks)) {
				let currentSubtaskId = 1;
				updatedTask.subtasks = updatedTask.subtasks.map((subtask) => {
					// Исправляем сгенерированные ИИ ID подзадач, которые могут быть строками или использовать ID родительской задачи в качестве префикса
					const correctedSubtask = {
						...subtask,
						id: currentSubtaskId, // Переопределяем сгенерированный ИИ ID правильным последовательным ID
						dependencies: Array.isArray(subtask.dependencies)
							? subtask.dependencies
									.map((dep) =>
										typeof dep === 'string' ? parseInt(dep, 10) : dep
									)
									.filter(
										(depId) =>
											!Number.isNaN(depId) &&
											depId >= 1 &&
											depId < currentSubtaskId
									)
							: [],
						status: subtask.status || 'pending'
					};
					currentSubtaskId++;
					return correctedSubtask;
				});
				report(
					'info',
					`Исправлено ${updatedTask.subtasks.length} ID подзадач на последовательные числовые ID.`
				);
			}

			// Сохраняем выполненные подзадачи (оставляем существующую логику)
			if (taskToUpdate.subtasks?.length > 0) {
				if (!updatedTask.subtasks) {
					report(
						'warn',
						'Подзадачи удалены ИИ. Восстанавливаем исходные подзадачи.'
					);
					updatedTask.subtasks = taskToUpdate.subtasks;
				} else {
					const completedOriginal = taskToUpdate.subtasks.filter(
						(st) => st.status === 'done' || st.status === 'completed'
					);
					completedOriginal.forEach((compSub) => {
						const updatedSub = updatedTask.subtasks.find(
							(st) => st.id === compSub.id
						);
						if (
							!updatedSub ||
							JSON.stringify(updatedSub) !== JSON.stringify(compSub)
						) {
							report(
								'warn',
								`Выполненная подзадача ${compSub.id} была изменена или удалена. Восстанавливаем.`
							);
							// Удаляем потенциально измененную версию
							updatedTask.subtasks = updatedTask.subtasks.filter(
								(st) => st.id !== compSub.id
							);
							// Добавляем обратно исходную
							updatedTask.subtasks.push(compSub);
						}
					});
					// Удаляем дубликаты на всякий случай
					const subtaskIds = new Set();
					updatedTask.subtasks = updatedTask.subtasks.filter((st) => {
						if (!subtaskIds.has(st.id)) {
							subtaskIds.add(st.id);
							return true;
						}
						report('warn', `Удален дублирующий ID подзадачи ${st.id}.`);
						return false;
					});
				}
			}
			// --- Конец валидации/коррекции задачи ---

			// --- Обновление данных задачи (оставляем существующие) ---
			data.tasks[taskIndex] = updatedTask;
			// --- Конец обновления данных задачи ---

			// --- Запись файла и генерация (без изменений) ---
			writeJSON(tasksPath, data, projectRoot, currentTag);
			report('success', `Задача ${taskId} успешно обновлена`);
			// await generateTaskFiles(tasksPath, path.dirname(tasksPath));
			// --- Конец записи файла ---

			// --- Отображение телеметрии CLI ---
			if (outputFormat === 'text' && aiServiceResponse.telemetryData) {
				displayAiUsageSummary(aiServiceResponse.telemetryData, 'cli'); // <<< ADD display
			}

			// --- Возврат успеха с телеметрией ---
			return {
				updatedTask: updatedTask, // Возвращаем обновленный объект задачи
				telemetryData: aiServiceResponse.telemetryData, // <<< ADD telemetryData
				tagInfo: aiServiceResponse.tagInfo
			};
		} catch (error) {
			// Перехватываем ошибки от generateTextService
			if (loadingIndicator) stopLoadingIndicator(loadingIndicator);
			report('error', `Ошибка во время вызова сервиса ИИ: ${error.message}`);
			if (error.message.includes('API key')) {
				report('error', 'Пожалуйста, убедитесь, что ключи API настроены правильно.');
			}
			throw error; // Повторно выбрасываем ошибку
		}
	} catch (error) {
		// Общий перехват ошибок
		// --- Общая обработка ошибок (оставляем существующую) ---
		report('error', `Ошибка при обновлении задачи: ${error.message}`);
		if (outputFormat === 'text') {
			console.error(chalk.red(`Ошибка: ${error.message}`));
			// ... полезные подсказки ...
			if (getDebugFlag(session)) console.error(error);
			process.exit(1);
		} else {
			throw error; // Повторно выбрасываем для MCP
		}
		return null; // Указываем на сбой в случае CLI, если процесс не завершается
		// --- Конец общей обработки ошибок ---
	}
}

export default updateTaskById;
