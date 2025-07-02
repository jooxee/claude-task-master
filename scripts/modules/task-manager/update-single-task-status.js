import chalk from 'chalk';

import { log } from '../utils.js';
import { isValidTaskStatus } from '../../../src/constants/task-status.js';

/**
 * Update the status of a single task
 * @param {string} tasksPath - Path to the tasks.json file
 * @param {string} taskIdInput - Task ID to update
 * @param {string} newStatus - New status
 * @param {Object} data - Tasks data
 * @param {boolean} showUi - Whether to show UI elements
 */
async function updateSingleTaskStatus(
	tasksPath,
	taskIdInput,
	newStatus,
	data,
	showUi = true
) {
	if (!isValidTaskStatus(newStatus)) {
		throw new Error(
				`Ошибка: Неверное значение статуса: ${newStatus}. Используйте одно из: ${TASK_STATUS_OPTIONS.join(', ')}`
			);
	}

	// Check if it's a subtask (e.g., "1.2")
	if (taskIdInput.includes('.')) {
		const [parentId, subtaskId] = taskIdInput
			.split('.')
			.map((id) => parseInt(id, 10));

		// Find the parent task
		const parentTask = data.tasks.find((t) => t.id === parentId);
		if (!parentTask) {
			throw new Error(`Родительская задача ${parentId} не найдена`);
		}

		// Find the subtask
		if (!parentTask.subtasks) {
			throw new Error(`Родительская задача ${parentId} не имеет подзадач`);
		}

		const subtask = parentTask.subtasks.find((st) => st.id === subtaskId);
		if (!subtask) {
			throw new Error(
				`Подзадача ${subtaskId} не найдена в родительской задаче ${parentId}`
			);
		}

		// Update the subtask status
		const oldStatus = subtask.status || 'pending';
		subtask.status = newStatus;

		log(
			'info',
			`Статус подзадачи ${parentId}.${subtaskId} обновлен с '${oldStatus}' на '${newStatus}'`
		);

		// Check if all subtasks are done (if setting to 'done')
		if (
			newStatus.toLowerCase() === 'done' ||
			newStatus.toLowerCase() === 'completed'
		) {
			const allSubtasksDone = parentTask.subtasks.every(
				(st) => st.status === 'done' || st.status === 'completed'
			);

			// Suggest updating parent task if all subtasks are done
			if (
				allSubtasksDone &&
				parentTask.status !== 'done' &&
				parentTask.status !== 'completed'
			) {
				// Only show suggestion in CLI mode
				if (showUi) {
					console.log(
						chalk.yellow(
							`Все подзадачи родительской задачи ${parentId} теперь отмечены как выполненные.`
						)
					);
					console.log(
						chalk.yellow(
							`Рассмотрите возможность обновления статуса родительской задачи с помощью: task-master set-status --id=${parentId} --status=done`
						)
					);
				}
			}
		}
	} else {
		// Handle regular task
		const taskId = parseInt(taskIdInput, 10);
		const task = data.tasks.find((t) => t.id === taskId);

		if (!task) {
			throw new Error(`Задача ${taskId} не найдена`);
		}

		// Update the task status
		const oldStatus = task.status || 'pending';
		task.status = newStatus;

		log(
			'info',
			`Статус задачи ${taskId} обновлен с '${oldStatus}' на '${newStatus}'`
		);

		// If marking as done, also mark all subtasks as done
		if (
			(newStatus.toLowerCase() === 'done' ||
				newStatus.toLowerCase() === 'completed') &&
			task.subtasks &&
			task.subtasks.length > 0
		) {
			const pendingSubtasks = task.subtasks.filter(
				(st) => st.status !== 'done' && st.status !== 'completed'
			);

			if (pendingSubtasks.length > 0) {
				log(
					'info',
					`Также отмечаем ${pendingSubtasks.length} подзадач как '${newStatus}'`
				);

				pendingSubtasks.forEach((subtask) => {
					subtask.status = newStatus;
				});
			}
		}
	}
}

export default updateSingleTaskStatus;
