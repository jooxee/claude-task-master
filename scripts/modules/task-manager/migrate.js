import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { fileURLToPath } from 'url';
import { createLogWrapper } from '../../../mcp-server/src/tools/utils.js';
import { findProjectRoot } from '../utils.js';
import {
	LEGACY_CONFIG_FILE,
	TASKMASTER_CONFIG_FILE
} from '../../../src/constants/paths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create a simple log wrapper for CLI use
const log = createLogWrapper({
	info: (msg) => console.log(chalk.blue('ℹ'), msg),
	warn: (msg) => console.log(chalk.yellow('⚠'), msg),
	error: (msg) => console.error(chalk.red('✗'), msg),
	success: (msg) => console.log(chalk.green('✓'), msg)
});

/**
 * Main migration function
 * @param {Object} options - Migration options
 */
export async function migrateProject(options = {}) {
	const projectRoot = findProjectRoot() || process.cwd();

	log.info(`Начало миграции в: ${projectRoot}`);

	// Check if .taskmaster directory already exists
	const taskmasterDir = path.join(projectRoot, '.taskmaster');
	if (fs.existsSync(taskmasterDir) && !options.force) {
		log.warn(
			'.taskmaster каталог уже существует. Используйте --force для перезаписи или пропуска миграции.'
		);
		return;
	}

	// Analyze what needs to be migrated
	const migrationPlan = analyzeMigrationNeeds(projectRoot);

	if (migrationPlan.length === 0) {
		log.info(
			'Нет файлов для миграции. Проект, возможно, уже использует новую структуру.'
		);
		return;
	}

	// Show migration plan
	log.info('План миграции:');
	for (const item of migrationPlan) {
		const action = options.dryRun ? 'Будет перемещено' : 'Будет перемещено';
		log.info(`  ${action}: ${item.from} → ${item.to}`);
	}

	if (options.dryRun) {
		log.info(
			'Сухой запуск завершен. Используйте --dry-run=false для выполнения фактической миграции.'
		);
		return;
	}

	// Confirm migration
	if (!options.yes) {
		const readline = await import('readline');
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout
		});

		const answer = await new Promise((resolve) => {
			rl.question('Продолжить миграцию? (y/N): ', resolve);
		});
		rl.close();

		if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
			log.info('Миграция отменена.');
			return;
		}
	}

	// Perform migration
	try {
		await performMigration(projectRoot, migrationPlan, options);
		log.success('Миграция успешно завершена!');
		log.info('Теперь вы можете использовать новую структуру каталогов .taskmaster.');
		if (!options.cleanup) {
			log.info(
				'Старые файлы были сохранены. Используйте --cleanup для их удаления после проверки.'
			);
		}
	} catch (error) {
		log.error(`Миграция не удалась: ${error.message}`);
		throw error;
	}
}

/**
 * Analyze what files need to be migrated
 * @param {string} projectRoot - Project root directory
 * @returns {Array} Migration plan items
 */
function analyzeMigrationNeeds(projectRoot) {
	const migrationPlan = [];

	// Check for tasks directory
	const tasksDir = path.join(projectRoot, 'tasks');
	if (fs.existsSync(tasksDir)) {
		const tasksFiles = fs.readdirSync(tasksDir);
		for (const file of tasksFiles) {
			migrationPlan.push({
				from: path.join('tasks', file),
				to: path.join('.taskmaster', 'tasks', file),
				type: 'task'
			});
		}
	}

	// Check for scripts directory files
	const scriptsDir = path.join(projectRoot, 'scripts');
	if (fs.existsSync(scriptsDir)) {
		const scriptsFiles = fs.readdirSync(scriptsDir);
		for (const file of scriptsFiles) {
			const filePath = path.join(scriptsDir, file);
			if (fs.statSync(filePath).isFile()) {
				// Categorize files more intelligently
				let destination;
				const lowerFile = file.toLowerCase();

				if (
					lowerFile.includes('example') ||
					lowerFile.includes('template') ||
					lowerFile.includes('boilerplate') ||
					lowerFile.includes('sample')
				) {
					// Template/example files go to templates (including example_prd.txt)
					destination = path.join('.taskmaster', 'templates', file);
				} else if (
					lowerFile.includes('complexity') &&
					lowerFile.includes('report') &&
					lowerFile.endsWith('.json')
				) {
					// Only actual complexity reports go to reports
					destination = path.join('.taskmaster', 'reports', file);
				} else if (
					lowerFile.includes('prd') ||
					lowerFile.endsWith('.md') ||
					lowerFile.endsWith('.txt')
				) {
					// Documentation files go to docs (but not examples or reports)
					destination = path.join('.taskmaster', 'docs', file);
				} else {
					// Other files stay in scripts or get skipped - don't force everything into templates
					log.warn(
						`Пропуск миграции '${file}' - неопределенная категоризация. Возможно, вам придется переместить этот файл вручную.`
					);
					continue;
				}

				migrationPlan.push({
					from: path.join('scripts', file),
					to: destination,
					type: 'script'
				});
			}
		}
	}

	// Check for .taskmasterconfig
	const oldConfig = path.join(projectRoot, LEGACY_CONFIG_FILE);
	if (fs.existsSync(oldConfig)) {
		migrationPlan.push({
			from: LEGACY_CONFIG_FILE,
			to: TASKMASTER_CONFIG_FILE,
			type: 'config'
		});
	}

	return migrationPlan;
}

/**
 * Perform the actual migration
 * @param {string} projectRoot - Project root directory
 * @param {Array} migrationPlan - List of files to migrate
 * @param {Object} options - Migration options
 */
async function performMigration(projectRoot, migrationPlan, options) {
	// Create .taskmaster directory
	const taskmasterDir = path.join(projectRoot, '.taskmaster');
	if (!fs.existsSync(taskmasterDir)) {
		fs.mkdirSync(taskmasterDir, { recursive: true });
	}

	// Group migration items by destination directory to create only needed subdirs
	const neededDirs = new Set();
	for (const item of migrationPlan) {
		const destDir = path.dirname(item.to);
		neededDirs.add(destDir);
	}

	// Create only the directories we actually need
	for (const dir of neededDirs) {
		const fullDirPath = path.join(projectRoot, dir);
		if (!fs.existsSync(fullDirPath)) {
			fs.mkdirSync(fullDirPath, { recursive: true });
			log.info(`Создан каталог: ${dir}`);
		}
	}

	// Create backup if requested
	if (options.backup) {
		const backupDir = path.join(projectRoot, '.taskmaster-migration-backup');
		log.info(`Создание резервной копии в: ${backupDir}`);
		if (fs.existsSync(backupDir)) {
			fs.rmSync(backupDir, { recursive: true, force: true });
		}
		fs.mkdirSync(backupDir, { recursive: true });
	}

	// Migrate files
	for (const item of migrationPlan) {
		const fromPath = path.join(projectRoot, item.from);
		const toPath = path.join(projectRoot, item.to);

		if (!fs.existsSync(fromPath)) {
			log.warn(`Исходный файл не найден: ${item.from}`);
			continue;
		}

		// Create backup if requested
		if (options.backup) {
			const backupPath = path.join(
				projectRoot,
				'.taskmaster-migration-backup',
				item.from
			);
			const backupDir = path.dirname(backupPath);
			if (!fs.existsSync(backupDir)) {
				fs.mkdirSync(backupDir, { recursive: true });
			}
			fs.copyFileSync(fromPath, backupPath);
		}

		// Ensure destination directory exists
		const toDir = path.dirname(toPath);
		if (!fs.existsSync(toDir)) {
			fs.mkdirSync(toDir, { recursive: true });
		}

		// Copy file
		fs.copyFileSync(fromPath, toPath);
		log.info(`Мигрировано: ${item.from} → ${item.to}`);

		// Remove original if cleanup is requested
		if (options.cleanup) {
			fs.unlinkSync(fromPath);
		}
	}

	// Clean up empty directories if cleanup is requested
	if (options.cleanup) {
		const dirsToCheck = ['tasks', 'scripts'];
		for (const dir of dirsToCheck) {
			const dirPath = path.join(projectRoot, dir);
			if (fs.existsSync(dirPath)) {
				try {
					const files = fs.readdirSync(dirPath);
					if (files.length === 0) {
						fs.rmdirSync(dirPath);
						log.info(`Удален пустой каталог: ${dir}`);
					}
				} catch (error) {
					// Directory not empty or other error, skip
				}
			}
		}
	}
}

export default { migrateProject };
