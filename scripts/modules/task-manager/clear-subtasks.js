import path from 'path';
import chalk from 'chalk';
import boxen from 'boxen';
import Table from 'cli-table3';

import { log, readJSON, writeJSON, truncate, isSilentMode } from '../utils.js';
import { displayBanner } from '../ui.js';

/**
 * Clear subtasks from specified tasks
 * @param {string} tasksPath - Path to the tasks.json file
 * @param {string} taskIds - Task IDs to clear subtasks from
 * @param {Object} context - Context object containing projectRoot and tag
 */
function clearSubtasks(tasksPath, taskIds, context = {}) {
	const { projectRoot, tag } = context;
	log('info', `Чтение задач из ${tasksPath}...`);
	const data = readJSON(tasksPath, projectRoot, tag);
	if (!data || !data.tasks) {
		log('error', 'Не найдено допустимых задач.');
		process.exit(1);
	}

	if (!isSilentMode()) {
		console.log(
			boxen(chalk.white.bold('Очистка подзадач'), {
				padding: 1,
				borderColor: 'blue',
				borderStyle: 'round',
				margin: { top: 1, bottom: 1 }
			})
		);
	}

	// Handle multiple task IDs (comma-separated)
	const taskIdArray = taskIds.split(',').map((id) => id.trim());
	let clearedCount = 0;

	// Create a summary table for the cleared subtasks
	const summaryTable = new Table({
		head: [
			chalk.cyan.bold('ID задачи'),
			chalk.cyan.bold('Заголовок задачи'),
			chalk.cyan.bold('Очищенные подзадачи')
		],
		colWidths: [10, 50, 20],
		style: { head: [], border: [] }
	});

	taskIdArray.forEach((taskId) => {
		const id = parseInt(taskId, 10);
		if (Number.isNaN(id)) {
			log('error', `Неверный ID задачи: ${taskId}`);
			return;
		}

		const task = data.tasks.find((t) => t.id === id);
		if (!task) {
			log('error', `Задача ${id} не найдена`);
			return;
		}

		if (!task.subtasks || task.subtasks.length === 0) {
			log('info', `У задачи ${id} нет подзадач для очистки`);
			summaryTable.push([
				id.toString(),
				truncate(task.title, 47),
				chalk.yellow('Нет подзадач')
			]);
			return;
		}

		const subtaskCount = task.subtasks.length;
		task.subtasks = [];
		clearedCount++;
		log('info', `Очищено ${subtaskCount} подзадач из задачи ${id}`);

		summaryTable.push([
			id.toString(),
			truncate(task.title, 47),
			chalk.green(`${subtaskCount} подзадач очищено`)
		]);
	});

	if (clearedCount > 0) {
		writeJSON(tasksPath, data, projectRoot, tag);

		// Show summary table
		if (!isSilentMode()) {
			console.log(
				boxen(chalk.white.bold('Сводка по очистке подзадач:'), {
					padding: { left: 2, right: 2, top: 0, bottom: 0 },
					margin: { top: 1, bottom: 0 },
					borderColor: 'blue',
					borderStyle: 'round'
				})
			);
			console.log(summaryTable.toString());
		}

		// Success message
		if (!isSilentMode()) {
			console.log(
				boxen(
					chalk.green(
						`Успешно очищены подзадачи из ${chalk.bold(clearedCount)} задач(и)`
					),
					{
						padding: 1,
						borderColor: 'green',
						borderStyle: 'round',
						margin: { top: 1 }
					}
				)
			);

			// Next steps suggestion
			console.log(
				boxen(
					chalk.white.bold('Следующие шаги:') +
						'\n\n' +
						`${chalk.cyan('1.')} Выполните ${chalk.yellow('task-master expand --id=<id>')}, чтобы сгенерировать новые подзадачи\n` +
						`${chalk.cyan('2.')} Выполните ${chalk.yellow('task-master list --with-subtasks')}, чтобы проверить изменения`,
					{
						padding: 1,
						borderColor: 'cyan',
						borderStyle: 'round',
						margin: { top: 1 }
					}
				)
			);
		}
	} else {
		if (!isSilentMode()) {
			console.log(
				boxen(chalk.yellow('Ни одна подзадача не была очищена'), {
					padding: 1,
					borderColor: 'yellow',
					borderStyle: 'round',
					margin: { top: 1 }
				})
			);
		}
	}
}

export default clearSubtasks;
