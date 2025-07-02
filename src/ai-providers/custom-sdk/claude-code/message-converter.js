/**
 * @fileoverview Converts AI SDK prompt format to Claude Code message format
 */

/**
 * Convert AI SDK prompt to Claude Code messages format
 * @param {Array} prompt - AI SDK prompt array
 * @param {Object} [mode] - Generation mode
 * @param {string} mode.type - Mode type ('regular', 'object-json', 'object-tool')
 * @returns {{messagesPrompt: string, systemPrompt?: string}}
 */
export function convertToClaudeCodeMessages(prompt, mode) {
	const messages = [];
	let systemPrompt;

	for (const message of prompt) {
		switch (message.role) {
			case 'system':
				systemPrompt = message.content;
				break;

			case 'user':
				if (typeof message.content === 'string') {
					messages.push(message.content);
				} else {
					// Handle multi-part content
					const textParts = message.content
						.filter((part) => part.type === 'text')
						.map((part) => part.text)
						.join('\n');

					if (textParts) {
						messages.push(textParts);
					}

					// Note: Image parts are not supported by Claude Code CLI
					const imageParts = message.content.filter(
						(part) => part.type === 'image'
					);
					if (imageParts.length > 0) {
						console.warn(
							'Claude Code CLI does not support image inputs. Images will be ignored.'
						);
					}
				}
				break;

			case 'assistant':
				if (typeof message.content === 'string') {
					messages.push(`Assistant: ${message.content}`);
				} else {
					const textParts = message.content
						.filter((part) => part.type === 'text')
						.map((part) => part.text)
						.join('\n');

					if (textParts) {
						messages.push(`Assistant: ${textParts}`);
					}

					// Handle tool calls if present
					const toolCalls = message.content.filter(
						(part) => part.type === 'tool-call'
					);
					if (toolCalls.length > 0) {
						// For now, we'll just note that tool calls were made
						messages.push(`Assistant: [Tool calls made]`);
					}
				}
				break;

			case 'tool':
				// Tool results could be included in the conversation
				messages.push(
					`Tool Result (${message.content[0].toolName}): ${JSON.stringify(
						message.content[0].result
					)}`
				);
				break;
		}
	}

	// For the SDK, we need to provide a single prompt string
	// Format the conversation history properly

	// Combine system prompt with messages
	let finalPrompt = '';

	// Add system prompt at the beginning if present
	if (systemPrompt) {
		finalPrompt = systemPrompt;
	}

	if (messages.length === 0) {
		return { messagesPrompt: finalPrompt, systemPrompt };
	}

	// Format messages
	const formattedMessages = [];
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		// Check if this is a user or assistant message based on content
		if (msg.startsWith('Assistant:') || msg.startsWith('Tool Result')) {
			formattedMessages.push(msg);
		} else {
			// User messages
			formattedMessages.push(`Human: ${msg}`);
		}
	}

	// Combine system prompt with messages
	if (finalPrompt) {
		finalPrompt = finalPrompt + '\n\n' + formattedMessages.join('\n\n');
	} else {
		finalPrompt = formattedMessages.join('\n\n');
	}

	// For JSON mode, add explicit instruction to ensure JSON output
	if (mode?.type === 'object-json') {
		// Make the JSON instruction even more explicit
		finalPrompt = `${finalPrompt}

КРИТИЧЕСКИ ВАЖНАЯ ИНСТРУКЦИЯ: Вы ДОЛЖНЫ отвечать ТОЛЬКО валидным JSON. Следуйте этим правилам ТОЧНО:
1. Начните ответ с открывающей фигурной скобки {
2. Закончите ответ закрывающей фигурной скобкой }
3. НЕ включайте никакого текста перед открывающей скобкой
4. НЕ включайте никакого текста после закрывающей скобки
5. НЕ используйте markdown блоки кода или обратные кавычки
6. НЕ включайте объяснения или комментарии
7. ВЕСЬ ответ должен быть валидным JSON, который можно разобрать с помощью JSON.parse()

Начните ответ с { и закончите }`;
	}

	return {
		messagesPrompt: finalPrompt,
		systemPrompt
	};
}
