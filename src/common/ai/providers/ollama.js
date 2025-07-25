const http = require('http');
const fetch = require('node-fetch');

function convertMessagesToOllamaFormat(messages) {
    return messages.map(msg => {
        if (Array.isArray(msg.content)) {
            let textContent = '';
            const images = [];
            
            for (const part of msg.content) {
                if (part.type === 'text') {
                    textContent += part.text;
                } else if (part.type === 'image_url') {
                    const base64 = part.image_url.url.replace(/^data:image\/[^;]+;base64,/, '');
                    images.push(base64);
                }
            }
            
            return {
                role: msg.role,
                content: textContent,
                ...(images.length > 0 && { images })
            };
        } else {
            return msg;
        }
    });
}

function createLLM({ 
    model, 
    temperature = 0.7, 
    maxTokens = 2048, 
    baseUrl = 'http://localhost:11434',
    ...config 
}) {
    if (!model) {
        throw new Error('Model parameter is required for Ollama LLM. Please specify a model name (e.g., "llama3.2:latest", "gemma3:4b")');
    }
    return {
        generateContent: async (parts) => {
            let systemPrompt = '';
            const userContent = [];

            for (const part of parts) {
                if (typeof part === 'string') {
                    if (systemPrompt === '' && part.includes('You are')) {
                        systemPrompt = part;
                    } else {
                        userContent.push(part);
                    }
                } else if (part.inlineData) {
                    userContent.push({
                        type: 'image',
                        image: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`
                    });
                }
            }

            const messages = [];
            if (systemPrompt) {
                messages.push({ role: 'system', content: systemPrompt });
            }
            messages.push({ role: 'user', content: userContent.join('\n') });

            try {
                const response = await fetch(`${baseUrl}/api/chat`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model,
                        messages,
                        stream: false,
                        options: {
                            temperature,
                            num_predict: maxTokens,
                        }
                    })
                });

                if (!response.ok) {
                    throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
                }

                const result = await response.json();
                
                return {
                    response: {
                        text: () => result.message.content
                    },
                    raw: result
                };
            } catch (error) {
                console.error('Ollama LLM error:', error);
                throw error;
            }
        },

        chat: async (messages) => {
            const ollamaMessages = convertMessagesToOllamaFormat(messages);

            try {
                const response = await fetch(`${baseUrl}/api/chat`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model,
                        messages: ollamaMessages,
                        stream: false,
                        options: {
                            temperature,
                            num_predict: maxTokens,
                        }
                    })
                });

                if (!response.ok) {
                    throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
                }

                const result = await response.json();
                
                return {
                    content: result.message.content,
                    raw: result
                };
            } catch (error) {
                console.error('Ollama chat error:', error);
                throw error;
            }
        }
    };
}

function createStreamingLLM({ 
    model, 
    temperature = 0.7, 
    maxTokens = 2048, 
    baseUrl = 'http://localhost:11434',
    ...config 
}) {
    if (!model) {
        throw new Error('Model parameter is required for Ollama streaming LLM. Please specify a model name (e.g., "llama3.2:latest", "gemma3:4b")');
    }
    return {
        streamChat: async (messages) => {
            console.log('[Ollama Provider] Starting streaming request');

            const ollamaMessages = convertMessagesToOllamaFormat(messages);
            console.log('[Ollama Provider] Converted messages for Ollama:', ollamaMessages);

            try {
                const response = await fetch(`${baseUrl}/api/chat`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model,
                        messages: ollamaMessages,
                        stream: true,
                        options: {
                            temperature,
                            num_predict: maxTokens,
                        }
                    })
                });

                if (!response.ok) {
                    throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
                }

                console.log('[Ollama Provider] Got streaming response');

                const stream = new ReadableStream({
                    async start(controller) {
                        let buffer = '';

                        try {
                            response.body.on('data', (chunk) => {
                                buffer += chunk.toString();
                                const lines = buffer.split('\n');
                                buffer = lines.pop() || '';

                                for (const line of lines) {
                                    if (line.trim() === '') continue;
                                    
                                    try {
                                        const data = JSON.parse(line);
                                        
                                        if (data.message?.content) {
                                            const sseData = JSON.stringify({
                                                choices: [{
                                                    delta: {
                                                        content: data.message.content
                                                    }
                                                }]
                                            });
                                            controller.enqueue(new TextEncoder().encode(`data: ${sseData}\n\n`));
                                        }
                                        
                                        if (data.done) {
                                            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
                                        }
                                    } catch (e) {
                                        console.error('[Ollama Provider] Failed to parse chunk:', e);
                                    }
                                }
                            });

                            response.body.on('end', () => {
                                controller.close();
                                console.log('[Ollama Provider] Streaming completed');
                            });

                            response.body.on('error', (error) => {
                                console.error('[Ollama Provider] Streaming error:', error);
                                controller.error(error);
                            });
                            
                        } catch (error) {
                            console.error('[Ollama Provider] Streaming setup error:', error);
                            controller.error(error);
                        }
                    }
                });

                return {
                    ok: true,
                    body: stream
                };
                
            } catch (error) {
                console.error('[Ollama Provider] Request error:', error);
                throw error;
            }
        }
    };
}

module.exports = {
    createLLM,
    createStreamingLLM
}; 