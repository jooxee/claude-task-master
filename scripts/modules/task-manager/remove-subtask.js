import path from 'path';
import { log, readJSON, writeJSON } from '../utils.js';
import generateTaskFiles from './generate-task-files.js';

/**
 * Remove a subtask from its parent task
 * @param {string} tasksPath - Path to the tasks.json file
 * @param {string} subtaskId - ID of the subtask to remove in format "parentId.subtaskId"
 * @param {boolean} convertToTask - Whether to convert the subtask to a standalone task
 * @param {boolean} generateFiles - Whether to regenerate task files after removing the subtask
 * @param {Object} context - Context object containing projectRoot and tag information
 * @returns {Object|null} The removed subtask if convertToTask is true, otherwise null
 */
async function removeSubtask(
	tasksPath,
	subtaskId,
	convertToTask = false,
	generateFiles = true,
	context = {}
) {
	try {
		log('info', `Удаление подзадачи ${subtaskId}...`);

		// Read the existing tasks with proper context
		const data = readJSON(tasksPath, context.projectRoot, context.tag);
		if (!data || !data.tasks) {
			throw new Error(`Неверный или отсутствующий файл задач по адресу ${tasksPath}`);
		}

		// Parse the subtask ID (format: "parentId.subtaskId")
		if (!subtaskId.includes('.')) {
			throw new Error(
				`Неверный формат ID подзадачи: ${subtaskId}. Ожидаемый формат: "parentId.subtaskId"`
			);
		}

		const [parentIdStr, subtaskIdStr] = subtaskId.split('.');
		const parentId = parseInt(parentIdStr, 10);
		const subtaskIdNum = parseInt(subtaskIdStr, 10);

		// Find the parent task
		const parentTask = data.tasks.find((t) => t.id === parentId);
		if (!parentTask) {
			throw new Error(`Родительская задача с ID ${parentId} не найдена`);
		}

		// Check if parent has subtasks
		if (!parentTask.subtasks || parentTask.subtasks.length === 0) {
			throw new Error(`Родительская задача ${parentId} не имеет подзадач`);
		}

		// Find the subtask to remove
		const subtaskIndex = parentTask.subtasks.findIndex(
			(st) => st.id === subtaskIdNum
		);
		if (subtaskIndex === -1) {
			throw new Error(`Подзадача ${subtaskId} не найдена`);
		}

		// Get a copy of the subtask before removing it
		const removedSubtask = { ...parentTask.subtasks[subtaskIndex] };

		// Remove the subtask from the parent
		parentTask.subtasks.splice(subtaskIndex, 1);

		// If parent has no more subtasks, remove the subtasks array
		if (parentTask.subtasks.length === 0) {
			parentTask.subtasks = undefined;
		}

		let convertedTask = null;

		// Convert the subtask to a standalone task if requested
		if (convertToTask) {
			log('info', `Преобразование подзадачи ${subtaskId} в отдельную задачу...`);

			// Find the highest task ID to determine the next ID
			const highestId = Math.max(...data.tasks.map((t) => t.id));
			const newTaskId = highestId + 1;

			// Create the new task from the subtask
			convertedTask = {
				id: newTaskId,
				title: removedSubtask.title,
				description: removedSubtask.description || '',
				details: removedSubtask.details || '',
				status: removedSubtask.status || 'pending',
				dependencies: removedSubtask.dependencies || [],
				priority: parentTask.priority || 'medium' // Inherit priority from parent
			};

			// Add the parent task as a dependency if not already present
			if (!convertedTask.dependencies.includes(parentId)) {
				convertedTask.dependencies.push(parentId);
			}

			// Add the converted task to the tasks array
			data.tasks.push(convertedTask);

			log('info', `Создана новая задача ${newTaskId} из подзадачи ${subtaskId}`);
		} else {
			log('info', `Подзадача ${subtaskId} удалена`);
		}

		// Write the updated tasks back to the file with proper context
		writeJSON(tasksPath, data, context.projectRoot, context.tag);

		// Generate task files if requested
		if (generateFiles) {
			log('info', 'Повторное создание файлов задач...');
			// await generateTaskFiles(tasksPath, path.dirname(tasksPath), context);
		}

		return convertedTask;
	} catch (error) {
		log('error', `Ошибка удаления подзадачи: ${error.message}`);
		throw error;
	}
}

export default removeSubtask;
