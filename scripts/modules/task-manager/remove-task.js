import fs from 'fs';
import path from 'path';

import { log, readJSON, writeJSON } from '../utils.js';
import generateTaskFiles from './generate-task-files.js';
import taskExists from './task-exists.js';

/**
 * Removes one or more tasks or subtasks from the tasks file
 * @param {string} tasksPath - Path to the tasks file
 * @param {string} taskIds - Comma-separated string of task/subtask IDs to remove (e.g., '5,6.1,7')
 * @param {Object} context - Context object containing projectRoot and tag information
 * @returns {Object} Result object with success status, messages, and removed task info
 */
async function removeTask(tasksPath, taskIds, context = {}) {
	const { projectRoot, tag } = context;
	const results = {
		success: true,
		messages: [],
		errors: [],
		removedTasks: []
	};
	const taskIdsToRemove = taskIds
		.split(',')
		.map((id) => id.trim())
		.filter(Boolean); // Remove empty strings if any

	if (taskIdsToRemove.length === 0) {
		results.success = false;
		results.errors.push('Не предоставлены действительные ID задач.');
		return results;
	}

	try {
		// Read the tasks file ONCE before the loop, preserving the full tagged structure
		const rawData = readJSON(tasksPath, projectRoot); // Read raw data
		if (!rawData) {
			throw new Error(`Не удалось прочитать файл задач по адресу ${tasksPath}`);
		}

		// Use the full tagged data if available, otherwise use the data as is
		const fullTaggedData = rawData._rawTaggedData || rawData;

		const currentTag = tag || rawData.tag || 'master';
		if (!fullTaggedData[currentTag] || !fullTaggedData[currentTag].tasks) {
			throw new Error(`Тег '${currentTag}' не найден или не содержит задач.`);
		}

		const tasks = fullTaggedData[currentTag].tasks; // Work with tasks from the correct tag

		const tasksToDeleteFiles = []; // Collect IDs of main tasks whose files should be deleted

		for (const taskId of taskIdsToRemove) {
			// Check if the task ID exists *before* attempting removal
			if (!taskExists(tasks, taskId)) {
				const errorMsg = `Задача с ID ${taskId} в теге '${currentTag}' не найдена или уже удалена.`;
				results.errors.push(errorMsg);
				results.success = false; // Mark overall success as false if any error occurs
				continue; // Skip to the next ID
			}

			try {
				// Handle subtask removal (e.g., '5.2')
				if (typeof taskId === 'string' && taskId.includes('.')) {
					const [parentTaskId, subtaskId] = taskId
						.split('.')
						.map((id) => parseInt(id, 10));

					// Find the parent task
					const parentTask = tasks.find((t) => t.id === parentTaskId);
					if (!parentTask || !parentTask.subtasks) {
						throw new Error(
							`Родительская задача ${parentTaskId} или ее подзадачи не найдены для подзадачи ${taskId}`
						);
					}

					// Find the subtask to remove
					const subtaskIndex = parentTask.subtasks.findIndex(
						(st) => st.id === subtaskId
					);
					if (subtaskIndex === -1) {
						throw new Error(
							`Подзадача ${subtaskId} не найдена в родительской задаче ${parentTaskId}`
						);
					}

					// Store the subtask info before removal
					const removedSubtask = {
						...parentTask.subtasks[subtaskIndex],
						parentTaskId: parentTaskId
					};
					results.removedTasks.push(removedSubtask);

					// Remove the subtask from the parent
					parentTask.subtasks.splice(subtaskIndex, 1);

					results.messages.push(
						`Успешно удалена подзадача ${taskId} из тега '${currentTag}'`
					);
				}
				// Handle main task removal
				else {
					const taskIdNum = parseInt(taskId, 10);
					const taskIndex = tasks.findIndex((t) => t.id === taskIdNum);
					if (taskIndex === -1) {
						throw new Error(
							`Задача с ID ${taskId} не найдена в теге '${currentTag}'`
						);
					}

					// Store the task info before removal
					const removedTask = tasks[taskIndex];
					results.removedTasks.push(removedTask);
					tasksToDeleteFiles.push(taskIdNum); // Add to list for file deletion

					// Remove the task from the main array
					tasks.splice(taskIndex, 1);

					results.messages.push(
						`Успешно удалена задача ${taskId} из тега '${currentTag}'`
					);
				}
			} catch (innerError) {
				// Catch errors specific to processing *this* ID
				const errorMsg = `Ошибка обработки ID ${taskId}: ${innerError.message}`;
				results.errors.push(errorMsg);
				results.success = false;
				log('warn', errorMsg); // Log as warning and continue with next ID
			}
		} // End of loop through taskIdsToRemove

		// --- Post-Loop Operations ---

		// Only proceed with cleanup and saving if at least one task was potentially removed
		if (results.removedTasks.length > 0) {
			const allRemovedIds = new Set(
				taskIdsToRemove.map((id) =>
					typeof id === 'string' && id.includes('.') ? id : parseInt(id, 10)
				)
			);

			// Update the tasks in the current tag of the full data structure
			fullTaggedData[currentTag].tasks = tasks;

			// Remove dependencies from all tags
			for (const tagName in fullTaggedData) {
				if (
					Object.prototype.hasOwnProperty.call(fullTaggedData, tagName) &&
					fullTaggedData[tagName] &&
					fullTaggedData[tagName].tasks
				) {
					const currentTagTasks = fullTaggedData[tagName].tasks;
					currentTagTasks.forEach((task) => {
						if (task.dependencies) {
							task.dependencies = task.dependencies.filter(
								(depId) => !allRemovedIds.has(depId)
							);
						}
						if (task.subtasks) {
							task.subtasks.forEach((subtask) => {
								if (subtask.dependencies) {
									subtask.dependencies = subtask.dependencies.filter(
										(depId) =>
											!allRemovedIds.has(`${task.id}.${depId}`) &&
											!allRemovedIds.has(depId)
									);
								}
							});
						}
					});
				}
			}

			// Save the updated raw data structure
			writeJSON(tasksPath, fullTaggedData);

			// Delete task files AFTER saving tasks.json
			for (const taskIdNum of tasksToDeleteFiles) {
				const taskFileName = path.join(
					path.dirname(tasksPath),
					`task_${taskIdNum.toString().padStart(3, '0')}.txt`
				);
				if (fs.existsSync(taskFileName)) {
					try {
						fs.unlinkSync(taskFileName);
						results.messages.push(`Удален файл задачи: ${taskFileName}`);
					} catch (unlinkError) {
						const unlinkMsg = `Не удалось удалить файл задачи ${taskFileName}: ${unlinkError.message}`;
						results.errors.push(unlinkMsg);
						results.success = false;
						log('warn', unlinkMsg);
					}
				}
			}

			// Generate updated task files ONCE, with context
			try {
				// await generateTaskFiles(tasksPath, path.dirname(tasksPath), {
				// 	projectRoot,
				// 	tag: currentTag
				// });
				results.messages.push('Файлы задач успешно перегенерированы.');
			} catch (genError) {
				const genErrMsg = `Не удалось перегенерировать файлы задач: ${genError.message}`;
				results.errors.push(genErrMsg);
				results.success = false;
				log('warn', genErrMsg);
			}
		} else if (results.errors.length === 0) {
			results.messages.push('Задачи, соответствующие предоставленным ID, не найдены.');
		}

		// Consolidate messages for final output
		const finalMessage = results.messages.join('\n');
		const finalError = results.errors.join('\n');

		return {
			success: results.success,
			message: finalMessage || 'Задачи не были удалены.',
			error: finalError || null,
			removedTasks: results.removedTasks
		};
	} catch (error) {
		// Catch errors from reading file or other initial setup
		log('error', `Ошибка удаления задач: ${error.message}`);
		return {
			success: false,
			message: '',
			error: `Операция не удалась: ${error.message}`,
			removedTasks: []
		};
	}
}

export default removeTask;
