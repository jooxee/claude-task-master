/**
 * models.js
 * Core functionality for managing AI model configurations
 */

import https from 'https';
import http from 'http';
import {
	getMainModelId,
	getResearchModelId,
	getFallbackModelId,
	getAvailableModels,
	getMainProvider,
	getResearchProvider,
	getFallbackProvider,
	isApiKeySet,
	getMcpApiKeyStatus,
	getConfig,
	writeConfig,
	isConfigFilePresent,
	getAllProviders,
	getBaseUrlForRole
} from '../config-manager.js';
import { findConfigPath } from '../../../src/utils/path-utils.js';
import { log } from '../utils.js';
import { CUSTOM_PROVIDERS } from '../../../src/constants/providers.js';

/**
 * Fetches the list of models from OpenRouter API.
 * @returns {Promise<Array|null>} A promise that resolves with the list of model IDs or null if fetch fails.
 */
function fetchOpenRouterModels() {
	return new Promise((resolve) => {
		const options = {
			hostname: 'openrouter.ai',
			path: '/api/v1/models',
			method: 'GET',
			headers: {
				Accept: 'application/json'
			}
		};

		const req = https.request(options, (res) => {
			let data = '';
			res.on('data', (chunk) => {
				data += chunk;
			});
			res.on('end', () => {
				if (res.statusCode === 200) {
					try {
						const parsedData = JSON.parse(data);
						resolve(parsedData.data || []); // Return the array of models
					} catch (e) {
						console.error('Ошибка разбора ответа OpenRouter:', e);
						resolve(null); // Indicate failure
					}
				} else {
					console.error(
						`Запрос к OpenRouter API завершился с ошибкой со статусом: ${res.statusCode}`
					);
					resolve(null); // Indicate failure
				}
			});
		});

		req.on('error', (e) => {
			console.error('Ошибка получения моделей OpenRouter:', e);
			resolve(null); // Indicate failure
		});
		req.end();
	});
}

/**
 * Fetches the list of models from Ollama instance.
 * @param {string} baseURL - The base URL for the Ollama API (e.g., "http://localhost:11434/api")
 * @returns {Promise<Array|null>} A promise that resolves with the list of model objects or null if fetch fails.
 */
function fetchOllamaModels(baseURL = 'http://localhost:11434/api') {
	return new Promise((resolve) => {
		try {
			// Parse the base URL to extract hostname, port, and base path
			const url = new URL(baseURL);
			const isHttps = url.protocol === 'https:';
			const port = url.port || (isHttps ? 443 : 80);
			const basePath = url.pathname.endsWith('/')
				? url.pathname.slice(0, -1)
				: url.pathname;

			const options = {
				hostname: url.hostname,
				port: parseInt(port, 10),
				path: `${basePath}/tags`,
				method: 'GET',
				headers: {
					Accept: 'application/json'
				}
			};

			const requestLib = isHttps ? https : http;
			const req = requestLib.request(options, (res) => {
				let data = '';
				res.on('data', (chunk) => {
					data += chunk;
				});
				res.on('end', () => {
					if (res.statusCode === 200) {
						try {
							const parsedData = JSON.parse(data);
							resolve(parsedData.models || []); // Return the array of models
						} catch (e) {
							console.error('Ошибка разбора ответа Ollama:', e);
							resolve(null); // Indicate failure
						}
					} else {
						console.error(
							`Запрос к Ollama API завершился с ошибкой со статусом: ${res.statusCode}`
						);
						resolve(null); // Indicate failure
					}
				});
			});

			req.on('error', (e) => {
				console.error('Ошибка получения моделей Ollama:', e);
				resolve(null); // Indicate failure
			});
			req.end();
		} catch (e) {
			console.error('Ошибка разбора базового URL Ollama:', e);
			resolve(null); // Indicate failure
		}
	});
}

/**
 * Get the current model configuration
 * @param {Object} [options] - Options for the operation
 * @param {Object} [options.session] - Session object containing environment variables (for MCP)
 * @param {Function} [options.mcpLog] - MCP logger object (for MCP)
 * @param {string} [options.projectRoot] - Project root directory
 * @returns {Object} RESTful response with current model configuration
 */
async function getModelConfiguration(options = {}) {
	const { mcpLog, projectRoot, session } = options;

	const report = (level, ...args) => {
		if (mcpLog && typeof mcpLog[level] === 'function') {
			mcpLog[level](...args);
		}
	};

	if (!projectRoot) {
		throw new Error('Требуется корневой каталог проекта, но он не найден.');
	}

	// Use centralized config path finding instead of hardcoded path
	const configPath = findConfigPath(null, { projectRoot });
	const configExists = isConfigFilePresent(projectRoot);

	log(
		'debug',
		`Проверка файла конфигурации с помощью findConfigPath, найдено: ${configPath}`
	);
	log(
		'debug',
		`Проверка файла конфигурации с помощью isConfigFilePresent(), существует: ${configExists}`
	);

	if (!configExists) {
		throw new Error(
			'Файл конфигурации отсутствует. Запустите "task-master models --setup", чтобы создать его.'
		);
	}

	try {
		// Get current settings - these should use the config from the found path automatically
		const mainProvider = getMainProvider(projectRoot);
		const mainModelId = getMainModelId(projectRoot);
		const researchProvider = getResearchProvider(projectRoot);
		const researchModelId = getResearchModelId(projectRoot);
		const fallbackProvider = getFallbackProvider(projectRoot);
		const fallbackModelId = getFallbackModelId(projectRoot);

		// Check API keys
		const mainCliKeyOk = isApiKeySet(mainProvider, session, projectRoot);
		const mainMcpKeyOk = getMcpApiKeyStatus(mainProvider, projectRoot);
		const researchCliKeyOk = isApiKeySet(
			researchProvider,
			session,
			projectRoot
		);
		const researchMcpKeyOk = getMcpApiKeyStatus(researchProvider, projectRoot);
		const fallbackCliKeyOk = fallbackProvider
			? isApiKeySet(fallbackProvider, session, projectRoot)
			: true;
		const fallbackMcpKeyOk = fallbackProvider
			? getMcpApiKeyStatus(fallbackProvider, projectRoot)
			: true;

		// Get available models to find detailed info
		const availableModels = getAvailableModels(projectRoot);

		// Find model details
		const mainModelData = availableModels.find((m) => m.id === mainModelId);
		const researchModelData = availableModels.find(
			(m) => m.id === researchModelId
		);
		const fallbackModelData = fallbackModelId
			? availableModels.find((m) => m.id === fallbackModelId)
			: null;

		// Return structured configuration data
		return {
			success: true,
			data: {
				activeModels: {
					main: {
						provider: mainProvider,
						modelId: mainModelId,
						sweScore: mainModelData?.swe_score || null,
						cost: mainModelData?.cost_per_1m_tokens || null,
						keyStatus: {
							cli: mainCliKeyOk,
							mcp: mainMcpKeyOk
						}
					},
					research: {
						provider: researchProvider,
						modelId: researchModelId,
						sweScore: researchModelData?.swe_score || null,
						cost: researchModelData?.cost_per_1m_tokens || null,
						keyStatus: {
							cli: researchCliKeyOk,
							mcp: researchMcpKeyOk
						}
					},
					fallback: fallbackProvider
						? {
								provider: fallbackProvider,
								modelId: fallbackModelId,
								sweScore: fallbackModelData?.swe_score || null,
								cost: fallbackModelData?.cost_per_1m_tokens || null,
								keyStatus: {
									cli: fallbackCliKeyOk,
									mcp: fallbackMcpKeyOk
								}
							}
						: null
				},
				message: 'Конфигурация текущей модели успешно получена'
			}
		};
	} catch (error) {
		report('error', `Ошибка получения конфигурации модели: ${error.message}`);
		return {
			success: false,
			error: {
				code: 'CONFIG_ERROR',
				message: error.message
			}
		};
	}
}

/**
 * Get all available models not currently in use
 * @param {Object} [options] - Options for the operation
 * @param {Object} [options.session] - Session object containing environment variables (for MCP)
 * @param {Function} [options.mcpLog] - MCP logger object (for MCP)
 * @param {string} [options.projectRoot] - Project root directory
 * @returns {Object} RESTful response with available models
 */
async function getAvailableModelsList(options = {}) {
	const { mcpLog, projectRoot } = options;

	const report = (level, ...args) => {
		if (mcpLog && typeof mcpLog[level] === 'function') {
			mcpLog[level](...args);
		}
	};

	if (!projectRoot) {
		throw new Error('Требуется корневой каталог проекта, но он не найден.');
	}

	// Use centralized config path finding instead of hardcoded path
	const configPath = findConfigPath(null, { projectRoot });
	const configExists = isConfigFilePresent(projectRoot);

	log(
		'debug',
		`Проверка файла конфигурации с помощью findConfigPath, найдено: ${configPath}`
	);
	log(
		'debug',
		`Проверка файла конфигурации с помощью isConfigFilePresent(), существует: ${configExists}`
	);

	if (!configExists) {
		throw new Error(
			'Файл конфигурации отсутствует. Запустите "task-master models --setup", чтобы создать его.'
		);
	}

	try {
		// Get all available models
		const allAvailableModels = getAvailableModels(projectRoot);

		if (!allAvailableModels || allAvailableModels.length === 0) {
			return {
				success: true,
				data: {
					models: [],
					message: 'Доступные модели не найдены'
				}
			};
		}

		// Get currently used model IDs
		const mainModelId = getMainModelId(projectRoot);
		const researchModelId = getResearchModelId(projectRoot);
		const fallbackModelId = getFallbackModelId(projectRoot);

		// Filter out placeholder models and active models
		const activeIds = [mainModelId, researchModelId, fallbackModelId].filter(
			Boolean
		);
		const otherAvailableModels = allAvailableModels.map((model) => ({
			provider: model.provider || 'N/A',
			modelId: model.id,
			sweScore: model.swe_score || null,
			cost: model.cost_per_1m_tokens || null,
			allowedRoles: model.allowed_roles || []
		}));

		return {
			success: true,
			data: {
				models: otherAvailableModels,
				message: `Успешно получено ${otherAvailableModels.length} доступных моделей`
			}
		};
	} catch (error) {
		report('error', `Ошибка получения доступных моделей: ${error.message}`);
		return {
			success: false,
			error: {
				code: 'MODELS_LIST_ERROR',
				message: error.message
			}
		};
	}
}

/**
 * Update a specific model in the configuration
 * @param {string} role - The model role to update ('main', 'research', 'fallback')
 * @param {string} modelId - The model ID to set for the role
 * @param {Object} [options] - Options for the operation
 * @param {string} [options.providerHint] - Provider hint if already determined ('openrouter' or 'ollama')
 * @param {Object} [options.session] - Session object containing environment variables (for MCP)
 * @param {Function} [options.mcpLog] - MCP logger object (for MCP)
 * @param {string} [options.projectRoot] - Project root directory
 * @returns {Object} RESTful response with result of update operation
 */
async function setModel(role, modelId, options = {}) {
	const { mcpLog, projectRoot, providerHint } = options;

	const report = (level, ...args) => {
		if (mcpLog && typeof mcpLog[level] === 'function') {
			mcpLog[level](...args);
		}
	};

	if (!projectRoot) {
		throw new Error('Требуется корневой каталог проекта, но он не найден.');
	}

	// Use centralized config path finding instead of hardcoded path
	const configPath = findConfigPath(null, { projectRoot });
	const configExists = isConfigFilePresent(projectRoot);

	log(
		'debug',
		`Проверка файла конфигурации с помощью findConfigPath, найдено: ${configPath}`
	);
	log(
		'debug',
		`Проверка файла конфигурации с помощью isConfigFilePresent(), существует: ${configExists}`
	);

	if (!configExists) {
		throw new Error(
			'Файл конфигурации отсутствует. Запустите "task-master models --setup", чтобы создать его.'
		);
	}

	// Validate role
	if (!['main', 'research', 'fallback'].includes(role)) {
		return {
			success: false,
			error: {
				code: 'INVALID_ROLE',
				message: `Неверная роль: ${role}. Должна быть одной из: main, research, fallback.`
			}
		};
	}

	// Validate model ID
	if (typeof modelId !== 'string' || modelId.trim() === '') {
		return {
			success: false,
			error: {
				code: 'INVALID_MODEL_ID',
				message: `Неверный ID модели: ${modelId}. Должна быть непустой строкой.`
			}
		};
	}

	try {
		const availableModels = getAvailableModels(projectRoot);
		const currentConfig = getConfig(projectRoot);
		let determinedProvider = null; // Initialize provider
		let warningMessage = null;

		// Find the model data in internal list initially to see if it exists at all
		let modelData = availableModels.find((m) => m.id === modelId);

		// --- Revised Logic: Prioritize providerHint --- //

		if (providerHint) {
			// Hint provided (--ollama or --openrouter flag used)
			if (modelData && modelData.provider === providerHint) {
				// Found internally AND provider matches the hint
				determinedProvider = providerHint;
				report(
					'info',
					`Модель ${modelId} найдена внутри с соответствующей подсказкой провайдера ${determinedProvider}.`
				);
			} else {
				// Either not found internally, OR found but under a DIFFERENT provider than hinted.
				// Proceed with custom logic based ONLY on the hint.
				if (providerHint === CUSTOM_PROVIDERS.OPENROUTER) {
					// Check OpenRouter ONLY because hint was openrouter
					report('info', `Проверка OpenRouter на ${modelId} (как указано)...`);
					const openRouterModels = await fetchOpenRouterModels();

					if (
						openRouterModels &&
						openRouterModels.some((m) => m.id === modelId)
					) {
						determinedProvider = CUSTOM_PROVIDERS.OPENROUTER;

						// Check if this is a free model (ends with :free)
						if (modelId.endsWith(':free')) {
							warningMessage = `Предупреждение: выбрана бесплатная модель OpenRouter '${modelId}'. Бесплатные модели имеют значительные ограничения, включая меньшие окна контекста, сниженные лимиты скорости и могут не поддерживать расширенные функции, такие как использование инструментов. Рассмотрите возможность использования платной версии '${modelId.replace(':free', '')}' для полной функциональности.`;
						} else {
							warningMessage = `Предупреждение: установлена пользовательская модель OpenRouter '${modelId}'. Эта модель официально не проверена Taskmaster и может работать не так, как ожидалось.`;
						}

						report('warn', warningMessage);
					} else {
						// Hinted as OpenRouter but not found in live check
						throw new Error(
							`ID модели "${modelId}" не найден в списке активных моделей OpenRouter. Пожалуйста, проверьте ID и убедитесь, что он доступен на OpenRouter.`
						);
					}
				} else if (providerHint === CUSTOM_PROVIDERS.OLLAMA) {
					// Check Ollama ONLY because hint was ollama
					report('info', `Проверка Ollama на ${modelId} (как указано)...`);

					// Get the Ollama base URL from config
					const ollamaBaseURL = getBaseUrlForRole(role, projectRoot);
					const ollamaModels = await fetchOllamaModels(ollamaBaseURL);

					if (ollamaModels === null) {
						// Connection failed - server probably not running
						throw new Error(
							`Не удалось подключиться к серверу Ollama по адресу ${ollamaBaseURL}. Пожалуйста, убедитесь, что Ollama запущена, и повторите попытку.`
						);
					} else if (ollamaModels.some((m) => m.model === modelId)) {
						determinedProvider = CUSTOM_PROVIDERS.OLLAMA;
						warningMessage = `Предупреждение: установлена пользовательская модель Ollama '${modelId}'. Убедитесь, что ваш сервер Ollama запущен и загрузил эту модель. Taskmaster не может гарантировать совместимость.`;
						report('warn', warningMessage);
					} else {
						// Server is running but model not found
						const tagsUrl = `${ollamaBaseURL}/tags`;
						throw new Error(
							`ID модели "${modelId}" не найден в экземпляре Ollama. Пожалуйста, убедитесь, что модель загружена и доступна. Вы можете проверить доступные модели с помощью: curl ${tagsUrl}`
						);
					}
				} else if (providerHint === CUSTOM_PROVIDERS.BEDROCK) {
					// Set provider without model validation since Bedrock models are managed by AWS
					determinedProvider = CUSTOM_PROVIDERS.BEDROCK;
					warningMessage = `Предупреждение: установлена пользовательская модель Bedrock '${modelId}'. Пожалуйста, убедитесь, что ID модели действителен и доступен в вашей учетной записи AWS.`;
					report('warn', warningMessage);
				} else if (providerHint === CUSTOM_PROVIDERS.CLAUDE_CODE) {
					// Claude Code provider - check if model exists in our list
					determinedProvider = CUSTOM_PROVIDERS.CLAUDE_CODE;
					// Re-find modelData specifically for claude-code provider
					const claudeCodeModels = availableModels.filter(
						(m) => m.provider === 'claude-code'
					);
					const claudeCodeModelData = claudeCodeModels.find(
						(m) => m.id === modelId
					);
					if (claudeCodeModelData) {
						// Update modelData to the found claude-code model
						modelData = claudeCodeModelData;
						report('info', `Установка модели Claude Code '${modelId}'.`);
					} else {
						warningMessage = `Предупреждение: модель Claude Code '${modelId}' не найдена в поддерживаемых моделях. Установка без проверки.`;
						report('warn', warningMessage);
					}
				} else if (providerHint === CUSTOM_PROVIDERS.AZURE) {
					// Set provider without model validation since Azure models are managed by Azure
					determinedProvider = CUSTOM_PROVIDERS.AZURE;
					warningMessage = `Предупреждение: установлена пользовательская модель Azure '${modelId}'. Пожалуйста, убедитесь, что развертывание модели действительно и доступно в вашей учетной записи Azure.`;
					report('warn', warningMessage);
				} else if (providerHint === CUSTOM_PROVIDERS.VERTEX) {
					// Set provider without model validation since Vertex models are managed by Google Cloud
					determinedProvider = CUSTOM_PROVIDERS.VERTEX;
					warningMessage = `Предупреждение: установлена пользовательская модель Vertex AI '${modelId}'. Пожалуйста, убедитесь, что модель действительна и доступна в вашем проекте Google Cloud.`;
					report('warn', warningMessage);
				} else {
					// Invalid provider hint - should not happen with our constants
					throw new Error(`Получена неверная подсказка провайдера: ${providerHint}`);
				}
			}
		} else {
			// No hint provided (flags not used)
			if (modelData) {
				// Found internally, use the provider from the internal list
				determinedProvider = modelData.provider;
				report(
					'info',
					`Модель ${modelId} найдена внутри с провайдером ${determinedProvider}.`
				);
			} else {
				// Model not found and no provider hint was given
				return {
					success: false,
					error: {
						code: 'MODEL_NOT_FOUND_NO_HINT',
						message: `ID модели "${modelId}" не найден в поддерживаемых моделях Taskmaster. Если это пользовательская модель, укажите провайдера с помощью --openrouter, --ollama, --bedrock, --azure или --vertex.`
					}
				};
			}
		}

		// --- End of Revised Logic --- //

		// At this point, we should have a determinedProvider if the model is valid (internally or custom)
		if (!determinedProvider) {
			// This case acts as a safeguard
			return {
				success: false,
				error: {
					code: 'PROVIDER_UNDETERMINED',
					message: `Не удалось определить провайдера для ID модели "${modelId}".`
				}
			};
		}

		// Update configuration
		currentConfig.models[role] = {
			...currentConfig.models[role], // Keep existing params like temperature
			provider: determinedProvider,
			modelId: modelId
		};

		// If model data is available, update maxTokens from supported-models.json
		if (modelData && modelData.max_tokens) {
			currentConfig.models[role].maxTokens = modelData.max_tokens;
		}

		// Write updated configuration
		const writeResult = writeConfig(currentConfig, projectRoot);
		if (!writeResult) {
			return {
				success: false,
				error: {
					code: 'CONFIG_WRITE_ERROR',
					message: 'Ошибка записи обновленной конфигурации в файл конфигурации'
				}
			};
		}

		const successMessage = `Успешно установлена модель ${role} на ${modelId} (Провайдер: ${determinedProvider})`;
		report('info', successMessage);

		return {
			success: true,
			data: {
				role,
				provider: determinedProvider,
				modelId,
				message: successMessage,
				warning: warningMessage // Include warning in the response data
			}
		};
	} catch (error) {
		report('error', `Ошибка установки модели ${role}: ${error.message}`);
		return {
			success: false,
			error: {
				code: 'SET_MODEL_ERROR',
				message: error.message
			}
		};
	}
}

/**
 * Get API key status for all known providers.
 * @param {Object} [options] - Options for the operation
 * @param {Object} [options.session] - Session object containing environment variables (for MCP)
 * @param {Function} [options.mcpLog] - MCP logger object (for MCP)
 * @param {string} [options.projectRoot] - Project root directory
 * @returns {Object} RESTful response with API key status report
 */
async function getApiKeyStatusReport(options = {}) {
	const { mcpLog, projectRoot, session } = options;
	const report = (level, ...args) => {
		if (mcpLog && typeof mcpLog[level] === 'function') {
			mcpLog[level](...args);
		}
	};

	try {
		const providers = getAllProviders();
		const providersToCheck = providers.filter(
			(p) => p.toLowerCase() !== 'ollama'
		); // Ollama is not a provider, it's a service, doesn't need an api key usually
		const statusReport = providersToCheck.map((provider) => {
			// Use provided projectRoot for MCP status check
			const cliOk = isApiKeySet(provider, session, projectRoot); // Pass session and projectRoot for CLI check
			const mcpOk = getMcpApiKeyStatus(provider, projectRoot);
			return {
				provider,
				cli: cliOk,
				mcp: mcpOk
			};
		});

		report('info', 'Отчет о состоянии ключа API успешно сгенерирован.');
		return {
			success: true,
			data: {
				report: statusReport,
				message: 'Отчет о состоянии ключа API сгенерирован.'
			}
		};
	} catch (error) {
		report('error', `Ошибка генерации отчета о состоянии ключа API: ${error.message}`);
		return {
			success: false,
			error: {
				code: 'API_KEY_STATUS_ERROR',
				message: error.message
			}
		};
	}
}

export {
	getModelConfiguration,
	getAvailableModelsList,
	setModel,
	getApiKeyStatusReport
};
