import fs from 'fs';
import path from 'path';
import chalk from 'chalk';

import { log, readJSON } from '../utils.js';
import { formatDependenciesWithStatus } from '../ui.js';
import { validateAndFixDependencies } from '../dependency-manager.js';
import { getDebugFlag } from '../config-manager.js';

/**
 * Generate individual task files from tasks.json
 * @param {string} tasksPath - Path to the tasks.json file
 * @param {string} outputDir - Output directory for task files
 * @param {Object} options - Additional options (mcpLog for MCP mode, projectRoot, tag)
 * @returns {Object|undefined} Result object in MCP mode, undefined in CLI mode
 */
function generateTaskFiles(tasksPath, outputDir, options = {}) {
	try {
		const isMcpMode = !!options?.mcpLog;

		// 1. Read the raw data structure, ensuring we have all tags.
		// We call readJSON without a specific tag to get the resolved default view,
		// which correctly contains the full structure in "_rawTaggedData".
		const resolvedData = readJSON(tasksPath, options.projectRoot);
		if (!resolvedData) {
			throw new Error("Не удалось прочитать или разобрать файл задач: ${tasksPath}");
		}
		// Prioritize the _rawTaggedData if it exists, otherwise use the data as is.
		const rawData = resolvedData._rawTaggedData || resolvedData;

		// 2. Determine the target tag we need to generate files for.
		const targetTag = options.tag || resolvedData.tag || 'master';
		const tagData = rawData[targetTag];

		if (!tagData || !tagData.tasks) {
			throw new Error(
				"Тег '${targetTag}' не найден или не содержит задач в данных."
			);
		}
		const tasksForGeneration = tagData.tasks;

		// Create the output directory if it doesn't exist
		if (!fs.existsSync(outputDir)) {
			fs.mkdirSync(outputDir, { recursive: true });
		}

		log(
			'info',
			"Подготовка к повторной генерации ${tasksForGeneration.length} файлов задач для тега '${targetTag}'"
		);

		// 3. Validate dependencies using the FULL, raw data structure to prevent data loss.
		validateAndFixDependencies(
			rawData, // Pass the entire object with all tags
			tasksPath,
			options.projectRoot,
			targetTag // Provide the current tag context for the operation
		);

		const allTasksInTag = tagData.tasks;
		const validTaskIds = allTasksInTag.map((task) => task.id);

		// Cleanup orphaned task files
		log('info', 'Проверка на наличие бесхозных файлов задач для очистки...');
		try {
			const files = fs.readdirSync(outputDir);
			// Tag-aware file patterns: master -> task_001.txt, other tags -> task_001_tagname.txt
			const masterFilePattern = /^task_(\d+)\.txt$/;
			const taggedFilePattern = new RegExp(`^task_(\\d+)_${targetTag}\\.txt$`);

			const orphanedFiles = files.filter((file) => {
				let match = null;
				let fileTaskId = null;

				// Check if file belongs to current tag
				if (targetTag === 'master') {
					match = file.match(masterFilePattern);
					if (match) {
						fileTaskId = parseInt(match[1], 10);
						// Only clean up master files when processing master tag
						return !validTaskIds.includes(fileTaskId);
					}
				} else {
					match = file.match(taggedFilePattern);
					if (match) {
						fileTaskId = parseInt(match[1], 10);
						// Only clean up files for the current tag
						return !validTaskIds.includes(fileTaskId);
					}
				}
				return false;
			});

			if (orphanedFiles.length > 0) {
				log(
					'info',
					"Найдено ${orphanedFiles.length} бесхозных файлов задач для удаления для тега '${targetTag}'"
				);
				orphanedFiles.forEach((file) => {
					const filePath = path.join(outputDir, file);
					fs.unlinkSync(filePath);
				});
			} else {
				log('info', 'Бесхозные файлы задач не найдены.');
			}
		} catch (err) {
			log('warn', "Ошибка при очистке бесхозных файлов задач: ${err.message}");
		}

		// Generate task files for the target tag
		log('info', "Генерация отдельных файлов задач для тега '${targetTag}'...");
		tasksForGeneration.forEach((task) => {
			// Tag-aware file naming: master -> task_001.txt, other tags -> task_001_tagname.txt
			const taskFileName =
				targetTag === 'master'
					? "task_${task.id.toString().padStart(3, '0')}.txt"
					: "task_${task.id.toString().padStart(3, '0')}_${targetTag}.txt";

			const taskPath = path.join(outputDir, taskFileName);

			let content = "# ID задачи: ${task.id}\n";
			content += "# Заголовок: ${task.title}\n";
			content += "# Статус: ${task.status || 'pending'}\n";

			if (task.dependencies && task.dependencies.length > 0) {
				content += "# Зависимости: ${formatDependenciesWithStatus(task.dependencies, allTasksInTag, false)}\n";
			} else {
				content += '# Зависимости: Нет\n';
			}

			content += "# Приоритет: ${task.priority || 'medium'}\n";
			content += "# Описание: ${task.description || ''}\n";
			content += '# Детали:\n';
			content += (task.details || '')
				.split('\n')
				.map((line) => line)
				.join('\n');
			content += '\n\n';
			content += '# Стратегия тестирования:\n';
			content += (task.testStrategy || '')
				.split('\n')
				.map((line) => line)
				.join('\n');
			content += '\n';

			if (task.subtasks && task.subtasks.length > 0) {
				content += '\n# Подзадачи:\n';
				task.subtasks.forEach((subtask) => {
					content += "## ${subtask.id}. ${subtask.title} [${subtask.status || 'pending'}]\n";
					if (subtask.dependencies && subtask.dependencies.length > 0) {
						const subtaskDeps = subtask.dependencies
							.map((depId) =>
								typeof depId === 'number'
									? "${task.id}.${depId}"
									: depId.toString()
							)
							.join(', ');
						content += "### Зависимости: ${subtaskDeps}\n";
					} else {
						content += '### Зависимости: Нет\n';
					}
					content += "### Описание: ${subtask.description || ''}\n";
					content += '### Детали:\n';
					content += (subtask.details || '')
						.split('\n')
						.map((line) => line)
						.join('\n');
					content += '\n\n';
				});
			}

			fs.writeFileSync(taskPath, content);
		});

		log(
			'success',
			"Все ${tasksForGeneration.length} задач для тега '${targetTag}' были сгенерированы в '${outputDir}'."
		);

		if (isMcpMode) {
			return {
				success: true,
				count: tasksForGeneration.length,
				directory: outputDir
			};
		}
	} catch (error) {
		log('error', "Ошибка при генерации файлов задач: ${error.message}");
		if (!options?.mcpLog) {
			console.error(chalk.red("Ошибка при генерации файлов задач: ${error.message}"));
			if (getDebugFlag()) {
				console.error(error);
			}
			process.exit(1);
		} else {
			throw error;
		}
	}
}

export default generateTaskFiles;
