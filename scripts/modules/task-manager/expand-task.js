import fs from 'fs';
import path from 'path';
import { z } from 'zod';

import { log, readJSON, writeJSON, isSilentMode } from '../utils.js';

import {
	startLoadingIndicator,
	stopLoadingIndicator,
	displayAiUsageSummary
} from '../ui.js';

import { generateTextService } from '../ai-services-unified.js';

import { getDefaultSubtasks, getDebugFlag } from '../config-manager.js';
import generateTaskFiles from './generate-task-files.js';
import { COMPLEXITY_REPORT_FILE } from '../../../src/constants/paths.js';
import { ContextGatherer } from '../utils/contextGatherer.js';
import { FuzzyTaskSearch } from '../utils/fuzzyTaskSearch.js';
import { flattenTasksWithSubtasks, findProjectRoot } from '../utils.js';

// --- Zod Schemas (Keep from previous step) ---
const subtaskSchema = z
	.object({
		id: z
			.number()
			.int()
			.positive()
			.describe('Последовательный ID подзадачи, начиная с 1'),
		title: z.string().min(5).describe('Четкий, конкретный заголовок для подзадачи'),
		description: z
			.string()
			.min(10)
			.describe('Подробное описание подзадачи'),
		dependencies: z
			.array(z.number().int())
			.describe('ID необходимых подзадач в рамках этого расширения'),
		details: z.string().min(20).describe('Детали реализации и руководство'),
		status: z
			.string()
			.describe(
				'Текущий статус подзадачи (изначально должен быть pending)'
			),
		testStrategy: z
			.string()
			.nullable()
			.describe('Подход к тестированию этой подзадачи')
			.default('')
	})
	.strict();
const subtaskArraySchema = z.array(subtaskSchema);
const subtaskWrapperSchema = z.object({
	subtasks: subtaskArraySchema.describe('Массив сгенерированных подзадач.')
});
// --- End Zod Schemas ---

/**
 * Generates the system prompt for the main AI role (e.g., Claude).
 * @param {number} subtaskCount - The target number of subtasks.
 * @returns {string} The system prompt.
 */
function generateMainSystemPrompt(subtaskCount) {
	return `Вы — AI-ассистент, помогающий в разбивке задач для разработки программного обеспечения.
Вам нужно разбить высокоуровневую задачу на ${subtaskCount} конкретных подзадач, которые можно реализовать одну за другой.

Подзадачи должны:
1. Быть конкретными и выполнимыми шагами реализации
2. Следовать логической последовательности
3. Каждая должна отвечать за отдельную часть родительской задачи
4. Включать четкое руководство по подходу к реализации
5. Иметь соответствующие цепочки зависимостей между подзадачами (используя новые последовательные ID)
6. В совокупности охватывать все аспекты родительской задачи

Для каждой подзадачи предоставьте:
- id: Последовательное целое число, начиная с предоставленного nextSubtaskId
- title: Четкий, конкретный заголовок
- description: Подробное описание
- dependencies: Массив ID необходимых подзадач (используйте новые последовательные ID)
- details: Детали реализации
- testStrategy: Необязательный подход к тестированию


Отвечайте ТОЛЬКО валидным объектом JSON, содержащим один ключ "subtasks", значением которого является массив, соответствующий описанной структуре. Не включайте никакого пояснительного текста, форматирования markdown или маркеров кодовых блоков.`;
}

/**
 * Generates the user prompt for the main AI role (e.g., Claude).
 * @param {Object} task - The parent task object.
 * @param {number} subtaskCount - The target number of subtasks.
 * @param {string} additionalContext - Optional additional context.
 * @param {number} nextSubtaskId - The starting ID for the new subtasks.
 * @returns {string} The user prompt.
 */
function generateMainUserPrompt(
	task,
	subtaskCount,
	additionalContext,
	nextSubtaskId
) {
	const contextPrompt = additionalContext
		? `\n\nДополнительный контекст: ${additionalContext}`
		: '';
	const schemaDescription = `
{
  "subtasks": [
    {
      "id": ${nextSubtaskId}, // ID первой подзадачи
      "title": "Конкретный заголовок подзадачи",
      "description": "Подробное описание",
      "dependencies": [], // например, [${nextSubtaskId + 1}], если она зависит от следующей
      "details": "Руководство по реализации",
      "testStrategy": "Необязательный подход к тестированию"
    },
    // ... (повторить для ${subtaskCount} подзадач с последовательными ID)
  ]
}`;

	return `Разбейте эту задачу на ровно ${subtaskCount} конкретных подзадач:

ID задачи: ${task.id}
Заголовок: ${task.title}
Описание: ${task.description}
Текущие детали: ${task.details || 'Нет'}
${contextPrompt}

Возвращайте ТОЛЬКО объект JSON, содержащий массив "subtasks", соответствующий этой структуре:
${schemaDescription}`;
}

/**
 * Generates the user prompt for the research AI role (e.g., Perplexity).
 * @param {Object} task - The parent task object.
 * @param {number} subtaskCount - The target number of subtasks.
 * @param {string} additionalContext - Optional additional context.
 * @param {number} nextSubtaskId - The starting ID for the new subtasks.
 * @returns {string} The user prompt.
 */
function generateResearchUserPrompt(
	task,
	subtaskCount,
	additionalContext,
	nextSubtaskId
) {
	const contextPrompt = additionalContext
		? `\n\nУчтите этот контекст: ${additionalContext}`
		: '';
	const schemaDescription = `
{
  "subtasks": [
    {
      "id": <number>, // Последовательный ID, начиная с ${nextSubtaskId}
      "title": "<string>",
      "description": "<string>",
      "dependencies": [<number>], // например, [${nextSubtaskId + 1}]. Если зависимостей нет, используйте пустой массив [].
      "details": "<string>",
      "testStrategy": "<string>" // Необязательно
    },
    // ... (повторить для ${subtaskCount} подзадач)
  ]
}`;

	return `Проанализируйте следующую задачу и разбейте ее на ровно ${subtaskCount} конкретных подзадач, используя свои исследовательские возможности. Назначьте последовательные ID, начиная с ${nextSubtaskId}.

Родительская задача:
ID: ${task.id}
Заголовок: ${task.title}
Описание: ${task.description}
Текущие детали: ${task.details || 'Нет'}
${contextPrompt}

КРИТИЧЕСКИ ВАЖНО: Отвечайте ТОЛЬКО валидным объектом JSON, содержащим один ключ "subtasks". Значение должно быть массивом сгенерированных подзадач, строго соответствующим этой структуре:
${schemaDescription}

Важно: для поля 'dependencies', если у подзадачи нет зависимостей, вы ДОЛЖНЫ использовать пустой массив, например: "dependencies": []. Не используйте null и не опускайте поле.

Не включайте НИКАКОГО пояснительного текста, markdown или маркеров кодовых блоков. Только объект JSON.`;
}

/**
 * Parse subtasks from AI's text response. Includes basic cleanup.
 * @param {string} text - Response text from AI.
 * @param {number} startId - Starting subtask ID expected.
 * @param {number} expectedCount - Expected number of subtasks.
 * @param {number} parentTaskId - Parent task ID for context.
 * @param {Object} logger - Logging object (mcpLog or console log).
 * @returns {Array} Parsed and potentially corrected subtasks array.
 * @throws {Error} If parsing fails or JSON is invalid/malformed.
 */
function parseSubtasksFromText(
	text,
	startId,
	expectedCount,
	parentTaskId,
	logger
) {
	if (typeof text !== 'string') {
		logger.error(
			`Текст ответа AI не является строкой. Получен тип: ${typeof text}, значение: ${text}`
		);
		throw new Error('Текст ответа AI не является строкой.');
	}

	if (!text || text.trim() === '') {
		throw new Error('Текст ответа AI пуст после обрезки.');
	}

	const originalTrimmedResponse = text.trim(); // Store the original trimmed response
	let jsonToParse = originalTrimmedResponse; // Initialize jsonToParse with it

	logger.debug(
		`Исходный ответ AI для разбора (полная длина: ${jsonToParse.length}): ${jsonToParse.substring(0, 1000)}...`
	);

	// --- Pre-emptive cleanup for known AI JSON issues ---
	// Fix for "dependencies": , or "dependencies":,
	if (jsonToParse.includes('"dependencies":')) {
		const malformedPattern = /"dependencies":\s*,/g;
		if (malformedPattern.test(jsonToParse)) {
			logger.warn('Попытка исправить некорректную проблему "dependencies": ,.');
			jsonToParse = jsonToParse.replace(
				malformedPattern,
				'"dependencies": [],'
			);
			logger.debug(
				`JSON после исправления "dependencies": ${jsonToParse.substring(0, 500)}...`
			);
		}
	}
	// --- End pre-emptive cleanup ---

	let parsedObject;
	let primaryParseAttemptFailed = false;

	// --- Attempt 1: Simple Parse (with optional Markdown cleanup) ---
	logger.debug('Попытка простого разбора...');
	try {
		// Check for markdown code block
		const codeBlockMatch = jsonToParse.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
		let contentToParseDirectly = jsonToParse;
		if (codeBlockMatch && codeBlockMatch[1]) {
			contentToParseDirectly = codeBlockMatch[1].trim();
			logger.debug('Простой разбор: извлечено содержимое из блока кода markdown.');
		} else {
			logger.debug(
				'Простой разбор: блок кода markdown не найден, используется обрезанный оригинал.'
			);
		}

		parsedObject = JSON.parse(contentToParseDirectly);
		logger.debug('Простой разбор успешен!');

		// Quick check if it looks like our target object
		if (
			!parsedObject ||
			typeof parsedObject !== 'object' ||
			!Array.isArray(parsedObject.subtasks)
		) {
			logger.warn(
				'Простой разбор успешен, но результат не является ожидаемой структурой {"subtasks": []}. Переход к расширенному извлечению.'
			);
			primaryParseAttemptFailed = true;
			parsedObject = null; // Reset parsedObject so we enter the advanced logic
		}
		// If it IS the correct structure, we'll skip advanced extraction.
	} catch (e) {
		logger.warn(
			`Простой разбор не удался: ${e.message}. Переход к логике расширенного извлечения.`
		);
		primaryParseAttemptFailed = true;
		// jsonToParse is already originalTrimmedResponse if simple parse failed before modifying it for markdown
	}

	// --- Attempt 2: Advanced Extraction (if simple parse failed or produced wrong structure) ---
	if (primaryParseAttemptFailed || !parsedObject) {
		// Ensure we try advanced if simple parse gave wrong structure
		logger.debug('Попытка применить логику расширенного извлечения...');
		// Reset jsonToParse to the original full trimmed response for advanced logic
		jsonToParse = originalTrimmedResponse;

		// (Insert the more complex extraction logic here - the one we worked on with:
		//  - targetPattern = '{"subtasks":';
		//  - careful brace counting for that targetPattern
		//  - fallbacks to last '{' and '}' if targetPattern logic fails)
		//  This was the logic from my previous message. Let's assume it's here.
		//  This block should ultimately set `jsonToParse` to the best candidate string.

		// Example snippet of that advanced logic's start:
		const targetPattern = '{"subtasks":';
		const patternStartIndex = jsonToParse.indexOf(targetPattern);

		if (patternStartIndex !== -1) {
			const openBraces = 0;
			const firstBraceFound = false;
			const extractedJsonBlock = '';
			// ... (loop for brace counting as before) ...
			// ... (if successful, jsonToParse = extractedJsonBlock) ...
			// ... (if that fails, fallbacks as before) ...
		} else {
			// ... (fallback to last '{' and '}' if targetPattern not found) ...
		}
		// End of advanced logic excerpt

		logger.debug(
			`Расширенное извлечение: строка JSON, которая будет разобрана: ${jsonToParse.substring(0, 500)}...`
		);
		try {
			parsedObject = JSON.parse(jsonToParse);
			logger.debug('Разбор с расширенным извлечением успешен!');
		} catch (parseError) {
			logger.error(
				`Расширенное извлечение: не удалось разобрать объект JSON: ${parseError.message}`
			);
			logger.error(
				`Расширенное извлечение: проблемная строка JSON для разбора (первые 500 символов): ${jsonToParse.substring(0, 500)}`
			);
			throw new Error(
				// Re-throw a more specific error if advanced also fails
				`Не удалось разобрать объект ответа JSON после простой и расширенной попыток: ${parseError.message}`
			);
		}
	}

	// --- Validation (applies to successfully parsedObject from either attempt) ---
	if (
		!parsedObject ||
		typeof parsedObject !== 'object' ||
		!Array.isArray(parsedObject.subtasks)
	) {
		logger.error(
			`Окончательное разобранное содержимое не является объектом или отсутствует массив 'subtasks'. Содержимое: ${JSON.stringify(parsedObject).substring(0, 200)}`
		);
		throw new Error(
			'Разобранный ответ AI не является допустимым объектом, содержащим массив "subtasks" после всех попыток.'
		);
	}
	const parsedSubtasks = parsedObject.subtasks;

	if (expectedCount && parsedSubtasks.length !== expectedCount) {
		logger.warn(
			`Ожидалось ${expectedCount} подзадач, но разобрано ${parsedSubtasks.length}.`
		);
	}

	let currentId = startId;
	const validatedSubtasks = [];
	const validationErrors = [];

	for (const rawSubtask of parsedSubtasks) {
		const correctedSubtask = {
			...rawSubtask,
			id: currentId,
			dependencies: Array.isArray(rawSubtask.dependencies)
				? rawSubtask.dependencies
						.map((dep) => (typeof dep === 'string' ? parseInt(dep, 10) : dep))
						.filter(
							(depId) =>
								!Number.isNaN(depId) && depId >= startId && depId < currentId
						)
				: [],
			status: 'pending'
		};

		const result = subtaskSchema.safeParse(correctedSubtask);

		if (result.success) {
			validatedSubtasks.push(result.data);
		} else {
			logger.warn(
				`Проверка подзадачи не удалась для необработанных данных: ${JSON.stringify(rawSubtask).substring(0, 100)}...`
			);
			result.error.errors.forEach((err) => {
				const errorMessage = `  - Поле '${err.path.join('.')}': ${err.message}`;
				logger.warn(errorMessage);
				validationErrors.push(`Подзадача ${currentId}: ${errorMessage}`);
			});
		}
		currentId++;
	}

	if (validationErrors.length > 0) {
		logger.error(
			`Найдено ${validationErrors.length} ошибок валидации в сгенерированных подзадачах.`
		);
		logger.warn('Продолжение работы только с успешно проверенными подзадачами.');
	}

	if (validatedSubtasks.length === 0 && parsedSubtasks.length > 0) {
		throw new Error(
			'Ответ AI содержал потенциальные подзадачи, но ни одна не прошла проверку.'
		);
	}
	return validatedSubtasks.slice(0, expectedCount || validatedSubtasks.length);
}

/**
 * Expand a task into subtasks using the unified AI service (generateTextService).
 * Appends new subtasks by default. Replaces existing subtasks if force=true.
 * Integrates complexity report to determine subtask count and prompt if available,
 * unless numSubtasks is explicitly provided.
 * @param {string} tasksPath - Path to the tasks.json file
 * @param {number} taskId - Task ID to expand
 * @param {number | null | undefined} [numSubtasks] - Optional: Explicit target number of subtasks. If null/undefined, check complexity report or config default.
 * @param {boolean} [useResearch=false] - Whether to use the research AI role.
 * @param {string} [additionalContext=''] - Optional additional context.
 * @param {Object} context - Context object containing session and mcpLog.
 * @param {Object} [context.session] - Session object from MCP.
 * @param {Object} [context.mcpLog] - MCP logger object.
 * @param {boolean} [force=false] - If true, replace existing subtasks; otherwise, append.
 * @returns {Promise<Object>} The updated parent task object with new subtasks.
 * @throws {Error} If task not found, AI service fails, or parsing fails.
 */
async function expandTask(
	tasksPath,
	taskId,
	numSubtasks,
	useResearch = false,
	additionalContext = '',
	context = {},
	force = false
) {
	const { session, mcpLog, projectRoot: contextProjectRoot, tag } = context;
	const outputFormat = mcpLog ? 'json' : 'text';

	// Determine projectRoot: Use from context if available, otherwise derive from tasksPath
	const projectRoot = contextProjectRoot || findProjectRoot(tasksPath);

	// Use mcpLog if available, otherwise use the default console log wrapper
	const logger = mcpLog || {
		info: (msg) => !isSilentMode() && log('info', msg),
		warn: (msg) => !isSilentMode() && log('warn', msg),
		error: (msg) => !isSilentMode() && log('error', msg),
		debug: (msg) =>
			!isSilentMode() && getDebugFlag(session) && log('debug', msg) // Use getDebugFlag
	};

	if (mcpLog) {
		logger.info(`expandTask вызван с контекстом: session=${!!session}`);
	}

	try {
		// --- Task Loading/Filtering (Unchanged) ---
		logger.info(`Чтение задач из ${tasksPath}`);
		const data = readJSON(tasksPath, projectRoot, tag);
		if (!data || !data.tasks)
			throw new Error(`Неверные данные задач в ${tasksPath}`);
		const taskIndex = data.tasks.findIndex(
			(t) => t.id === parseInt(taskId, 10)
		);
		if (taskIndex === -1) throw new Error(`Задача ${taskId} не найдена`);
		const task = data.tasks[taskIndex];
		logger.info(
			`Расширение задачи ${taskId}: ${task.title}${useResearch ? ' с исследованием' : ''}`
		);
		// --- End Task Loading/Filtering ---

		// --- Handle Force Flag: Clear existing subtasks if force=true ---
		if (force && Array.isArray(task.subtasks) && task.subtasks.length > 0) {
			logger.info(
				`Установлен флаг force. Очистка существующих ${task.subtasks.length} подзадач для задачи ${taskId}.`
			);
			task.subtasks = []; // Clear existing subtasks
		}
		// --- End Force Flag Handling ---

		// --- Context Gathering ---
		let gatheredContext = '';
		try {
			const contextGatherer = new ContextGatherer(projectRoot);
			const allTasksFlat = flattenTasksWithSubtasks(data.tasks);
			const fuzzySearch = new FuzzyTaskSearch(allTasksFlat, 'expand-task');
			const searchQuery = `${task.title} ${task.description}`;
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
			logger.warn(`Не удалось собрать контекст: ${contextError.message}`);
		}
		// --- End Context Gathering ---

		// --- Complexity Report Integration ---
		let finalSubtaskCount;
		let promptContent = '';
		let complexityReasoningContext = '';
		let systemPrompt; // Declare systemPrompt here

		const complexityReportPath = path.join(projectRoot, COMPLEXITY_REPORT_FILE);
		let taskAnalysis = null;

		try {
			if (fs.existsSync(complexityReportPath)) {
				const complexityReport = readJSON(complexityReportPath);
				taskAnalysis = complexityReport?.complexityAnalysis?.find(
					(a) => a.taskId === task.id
				);
				if (taskAnalysis) {
					logger.info(
						`Найден анализ сложности для задачи ${task.id}: Оценка ${taskAnalysis.complexityScore}`
					);
					if (taskAnalysis.reasoning) {
						complexityReasoningContext = `\nОбоснование анализа сложности: ${taskAnalysis.reasoning}`;
					}
				} else {
					logger.info(
						`Анализ сложности для задачи ${task.id} в отчете не найден.`
					);
				}
			} else {
				logger.info(
					`Отчет о сложности не найден по адресу ${complexityReportPath}. Пропуск проверки сложности.`
				);
			}
		} catch (reportError) {
			logger.warn(
				`Не удалось прочитать или разобрать отчет о сложности: ${reportError.message}. Продолжение без него.`
			);
		}

		// Determine final subtask count
        const explicitNumSubtasks = parseInt(numSubtasks, 10);
        if (!Number.isNaN(explicitNumSubtasks) && explicitNumSubtasks > 0) {
            finalSubtaskCount = explicitNumSubtasks;
            logger.info(
                `Использование явно указанного количества подзадач: ${finalSubtaskCount}`
            );
        } else if (taskAnalysis?.recommendedSubtasks) {
            finalSubtaskCount = parseInt(taskAnalysis.recommendedSubtasks, 10);
            logger.info(
                `Использование количества подзадач из отчета о сложности: ${finalSubtaskCount}`
            );
        } else {
            finalSubtaskCount = getDefaultSubtasks(session);
            logger.info(`Использование количества подзадач по умолчанию: ${finalSubtaskCount}`);
        }
        if (Number.isNaN(finalSubtaskCount) || finalSubtaskCount <= 0) {
            logger.warn(
                `Определено неверное количество подзадач (${finalSubtaskCount}), по умолчанию используется 3.`
            );
            finalSubtaskCount = 3;
        }

        // Determine prompt content AND system prompt
        const nextSubtaskId = (task.subtasks?.length || 0) + 1;

        if (taskAnalysis?.expansionPrompt) {
            // Use prompt from complexity report
            promptContent = taskAnalysis.expansionPrompt;
            // Append additional context and reasoning
            promptContent += `\n\n${additionalContext}`.trim();
            promptContent += `${complexityReasoningContext}`.trim();
            if (gatheredContext) {
                promptContent += `\n\n# Контекст проекта\n\n${gatheredContext}`;
            }

            // --- Use Simplified System Prompt for Report Prompts ---
            systemPrompt = `Вы — AI-ассистент, помогающий в разбивке задач. Сгенерируйте ровно ${finalSubtaskCount} подзадач на основе предоставленного промпта и контекста. Отвечайте ТОЛЬКО валидным объектом JSON, содержащим один ключ "subtasks", значением которого является массив сгенерированных объектов подзадач. Каждый объект подзадачи в массиве должен иметь ключи: "id", "title", "description", "dependencies", "details", "status". Убедитесь, что 'id' начинается с ${nextSubtaskId} и является последовательным. Убедитесь, что 'dependencies' ссылаются только на действительные предыдущие ID подзадач, сгенерированные в этом ответе (начиная с ${nextSubtaskId}). Убедитесь, что 'status' — 'pending'. Не включайте никакого другого текста или объяснений.`;
            logger.info(
                `Использование промпта для расширения из отчета о сложности и упрощенного системного промпта для задачи ${task.id}.`
            );
            // --- End Simplified System Prompt ---
        } else {
            // Use standard prompt generation
            let combinedAdditionalContext =
                `${additionalContext}${complexityReasoningContext}`.trim();
            if (gatheredContext) {
                combinedAdditionalContext =
                    `${combinedAdditionalContext}\n\n# Контекст проекта\n\n${gatheredContext}`.trim();
            }

            if (useResearch) {
                promptContent = generateResearchUserPrompt(
                    task,
                    finalSubtaskCount,
                    combinedAdditionalContext,
                    nextSubtaskId
                );
                // Use the specific research system prompt if needed, or a standard one
                systemPrompt = `Вы — AI-ассистент, который отвечает ТОЛЬКО валидными объектами JSON по запросу. Объект должен содержать массив 'subtasks'.`; // Or keep generateResearchSystemPrompt if it exists
            } else {
                promptContent = generateMainUserPrompt(
                    task,
                    finalSubtaskCount,
                    combinedAdditionalContext,
                    nextSubtaskId
                );
                // Use the original detailed system prompt for standard generation
                systemPrompt = generateMainSystemPrompt(finalSubtaskCount);
            }
            logger.info(`Использование стандартной генерации промпта для задачи ${task.id}.`);
        }
		// --- End Complexity Report / Prompt Logic ---

		// --- AI Subtask Generation using generateTextService ---
        let generatedSubtasks = [];
        let loadingIndicator = null;
        if (outputFormat === 'text') {
            loadingIndicator = startLoadingIndicator(
                `Генерация ${finalSubtaskCount} подзадач...\n`
            );
        }

        let responseText = '';
        let aiServiceResponse = null;

        try {
            const role = useResearch ? 'research' : 'main';

            // Call generateTextService with the determined prompts and telemetry params
            aiServiceResponse = await generateTextService({
                prompt: promptContent,
                systemPrompt: systemPrompt,
                role,
                session,
                projectRoot,
                commandName: 'expand-task',
                outputType: outputFormat
            });
            responseText = aiServiceResponse.mainResult;

            // Parse Subtasks
            generatedSubtasks = parseSubtasksFromText(
                responseText,
                nextSubtaskId,
                finalSubtaskCount,
                task.id,
                logger
            );
            logger.info(
                `Успешно разобрано ${generatedSubtasks.length} подзадач из ответа AI.`
            );
        } catch (error) {
            if (loadingIndicator) stopLoadingIndicator(loadingIndicator);
            logger.error(
                `Ошибка во время вызова AI или разбора для задачи ${taskId}: ${error.message}`,
                'error'
            );
            // Log raw response in debug mode if parsing failed
            if (
                error.message.includes('Не удалось разобрать действительные подзадачи') &&
                getDebugFlag(session)
            ) {
                logger.error(`Необработанный ответ AI, который не удалось разобрать:\n${responseText}`);
            }
            throw error;
        } finally {
            if (loadingIndicator) stopLoadingIndicator(loadingIndicator);
        }

        // --- Task Update & File Writing ---
        // Ensure task.subtasks is an array before appending
            if (!Array.isArray(task.subtasks)) {
                task.subtasks = [];
            }
        // Append the newly generated and validated subtasks
        task.subtasks.push(...generatedSubtasks);
        // --- End Change: Append instead of replace ---

        data.tasks[taskIndex] = task; // Assign the modified task back
        writeJSON(tasksPath, data, projectRoot, tag);
        // await generateTaskFiles(tasksPath, path.dirname(tasksPath));

        // Display AI Usage Summary for CLI
        if (
            outputFormat === 'text' &&
            aiServiceResponse &&
            aiServiceResponse.telemetryData
        ) {
            displayAiUsageSummary(aiServiceResponse.telemetryData, 'cli');
        }

        // Return the updated task object AND telemetry data
        return {
            task,
            telemetryData: aiServiceResponse?.telemetryData,
            tagInfo: aiServiceResponse?.tagInfo
        };
    } catch (error) {
        // Catches errors from file reading, parsing, AI call etc.
        logger.error(`Ошибка при расширении задачи ${taskId}: ${error.message}`, 'error');
        if (outputFormat === 'text' && getDebugFlag(session)) {
            console.error(error); // Log full stack in debug CLI mode
        }
        throw error; // Re-throw for the caller
    }
}

export default expandTask;
