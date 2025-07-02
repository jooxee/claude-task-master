import path from 'path';

import { log, readJSON, writeJSON } from '../utils.js';
import { isTaskDependentOn } from '../task-manager.js';
import generateTaskFiles from './generate-task-files.js';

/**
 * Add a subtask to a parent task
 * @param {string} tasksPath - Path to the tasks.json file
 * @param {number|string} parentId - ID of the parent task
 * @param {number|string|null} existingTaskId - ID of an existing task to convert to subtask (optional)
 * @param {Object} newSubtaskData - Data for creating a new subtask (used if existingTaskId is null)
 * @param {boolean} generateFiles - Whether to regenerate task files after adding the subtask
 * @param {Object} context - Context object containing projectRoot and tag information
 * @returns {Object} The newly created or converted subtask
 */
async function addSubtask(
	tasksPath,
	parentId,
	existingTaskId = null,
	newSubtaskData = null,
	generateFiles = true,
	context = {}
) {
	try {
		log('info', `Добавление подзадачи к родительской задаче ${parentId}...`);

		// Read the existing tasks with proper context
		const data = readJSON(tasksPath, context.projectRoot, context.tag);
		if (!data || !data.tasks) {
			throw new Error(`Неверный или отсутствующий файл задач по адресу ${tasksPath}`);
		}

		// Convert parent ID to number
		const parentIdNum = parseInt(parentId, 10);

		// Find the parent task
		const parentTask = data.tasks.find((t) => t.id === parentIdNum);
		if (!parentTask) {
			throw new Error(`Родительская задача с ID ${parentIdNum} не найдена`);
		}

		// Initialize subtasks array if it doesn't exist
		if (!parentTask.subtasks) {
			parentTask.subtasks = [];
		}

		let newSubtask;

		// Case 1: Convert an existing task to a subtask
		if (existingTaskId !== null) {
			const existingTaskIdNum = parseInt(existingTaskId, 10);

			// Find the existing task
			const existingTaskIndex = data.tasks.findIndex(
				(t) => t.id === existingTaskIdNum
			);
			if (existingTaskIndex === -1) {
				throw new Error(`Задача с ID ${existingTaskIdNum} не найдена`);
			}

			const existingTask = data.tasks[existingTaskIndex];

			// Check if task is already a subtask
			if (existingTask.parentTaskId) {
				throw new Error(
					`Задача ${existingTaskIdNum} уже является подзадачей задачи ${existingTask.parentTaskId}`
				);
			}

			// Check for circular dependency
			if (existingTaskIdNum === parentIdNum) {
				throw new Error(`Невозможно сделать задачу подзадачей самой себя`);
			}

			// Check if parent task is a subtask of the task we're converting
			// This would create a circular dependency
			if (isTaskDependentOn(data.tasks, parentTask, existingTaskIdNum)) {
				throw new Error(
					`Невозможно создать циклическую зависимость: задача ${parentIdNum} уже является подзадачей или зависит от задачи ${existingTaskIdNum}`
				);
			}

			// Find the highest subtask ID to determine the next ID
			const highestSubtaskId =
				parentTask.subtasks.length > 0
					? Math.max(...parentTask.subtasks.map((st) => st.id))
					: 0;
			const newSubtaskId = highestSubtaskId + 1;

			// Clone the existing task to be converted to a subtask
			newSubtask = {
				...existingTask,
				id: newSubtaskId,
				parentTaskId: parentIdNum
			};

			// Add to parent's subtasks
			parentTask.subtasks.push(newSubtask);

			// Remove the task from the main tasks array
			data.tasks.splice(existingTaskIndex, 1);

			log(
				'info',
				`Задача ${existingTaskIdNum} преобразована в подзадачу ${parentIdNum}.${newSubtaskId}`
			);
		}
		// Case 2: Create a new subtask
		else if (newSubtaskData) {
			// Find the highest subtask ID to determine the next ID
			const highestSubtaskId =
				parentTask.subtasks.length > 0
					? Math.max(...parentTask.subtasks.map((st) => st.id))
					: 0;
			const newSubtaskId = highestSubtaskId + 1;

			// Create the new subtask object
			newSubtask = {
				id: newSubtaskId,
				title: newSubtaskData.title,
				description: newSubtaskData.description || '',
				details: newSubtaskData.details || '',
				status: newSubtaskData.status || 'pending',
				dependencies: newSubtaskData.dependencies || [],
				parentTaskId: parentIdNum
			};

			// Add to parent's subtasks
			parentTask.subtasks.push(newSubtask);

			log('info', `Создана новая подзадача ${parentIdNum}.${newSubtaskId}`);
		} else {
			throw new Error(
				'Необходимо предоставить либо existingTaskId, либо newSubtaskData'
			);
		}

		// Write the updated tasks back to the file with proper context
		writeJSON(tasksPath, data, context.projectRoot, context.tag);

		// Generate task files if requested
		if (generateFiles) {
			log('info', 'Повторное создание файлов задач...');
			// await generateTaskFiles(tasksPath, path.dirname(tasksPath), context);
		}

		return newSubtask;
	} catch (error) {
		log('error', `Ошибка при добавлении подзадачи: ${error.message}`);
		throw error;
	}
}

export default addSubtask;
