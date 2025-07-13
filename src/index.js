// try {
//     const reloader = require('electron-reloader');
//     reloader(module, {
//     });
// } catch (err) {
// }

require('dotenv').config();

if (require('electron-squirrel-startup')) {
    process.exit(0);
}

const { app, BrowserWindow, shell, ipcMain, dialog, desktopCapturer, session } = require('electron');
const { createWindows } = require('./electron/windowManager.js');
const ListenService = require('./features/listen/listenService');
const { initializeFirebase } = require('./common/services/firebaseClient');
const databaseInitializer = require('./common/services/databaseInitializer');
const authService = require('./common/services/authService');
const path = require('node:path');
const express = require('express');
const fetch = require('node-fetch');
const { autoUpdater } = require('electron-updater');
const { EventEmitter } = require('events');
const askService = require('./features/ask/askService');
const settingsService = require('./features/settings/settingsService');
const sessionRepository = require('./common/repositories/session');
const ModelStateService = require('./common/services/modelStateService');
const sqliteClient = require('./common/services/sqliteClient');

// Global variables
const eventBridge = new EventEmitter();
let WEB_PORT = 3000;
let isShuttingDown = false; // Flag to prevent infinite shutdown loop

const listenService = new ListenService();
// Make listenService globally accessible so other modules (e.g., windowManager, askService) can reuse the same instance
global.listenService = listenService;

//////// after_modelStateService ////////
const modelStateService = new ModelStateService(authService);
global.modelStateService = modelStateService;
//////// after_modelStateService ////////

// Import and initialize OllamaService
const ollamaService = require('./common/services/ollamaService');
const ollamaModelRepository = require('./common/repositories/ollamaModel');

// Native deep link handling - cross-platform compatible
let pendingDeepLinkUrl = null;

function setupProtocolHandling() {
    // Protocol registration - must be done before app is ready
    try {
        if (!app.isDefaultProtocolClient('pickleglass')) {
            const success = app.setAsDefaultProtocolClient('pickleglass');
            if (success) {
                console.log('[Protocol] Successfully set as default protocol client for pickleglass://');
            } else {
                console.warn('[Protocol] Failed to set as default protocol client - this may affect deep linking');
            }
        } else {
            console.log('[Protocol] Already registered as default protocol client for pickleglass://');
        }
    } catch (error) {
        console.error('[Protocol] Error during protocol registration:', error);
    }

    // Handle protocol URLs on Windows/Linux
    app.on('second-instance', (event, commandLine, workingDirectory) => {
        console.log('[Protocol] Second instance command line:', commandLine);
        
        focusMainWindow();
        
        let protocolUrl = null;
        
        // Search through all command line arguments for a valid protocol URL
        for (const arg of commandLine) {
            if (arg && typeof arg === 'string' && arg.startsWith('pickleglass://')) {
                // Clean up the URL by removing problematic characters
                const cleanUrl = arg.replace(/[\\₩]/g, '');
                
                // Additional validation for Windows
                if (process.platform === 'win32') {
                    // On Windows, ensure the URL doesn't contain file path indicators
                    if (!cleanUrl.includes(':') || cleanUrl.indexOf('://') === cleanUrl.lastIndexOf(':')) {
                        protocolUrl = cleanUrl;
                        break;
                    }
                } else {
                    protocolUrl = cleanUrl;
                    break;
                }
            }
        }
        
        if (protocolUrl) {
            console.log('[Protocol] Valid URL found from second instance:', protocolUrl);
            handleCustomUrl(protocolUrl);
        } else {
            console.log('[Protocol] No valid protocol URL found in command line arguments');
            console.log('[Protocol] Command line args:', commandLine);
        }
    });

    // Handle protocol URLs on macOS
    app.on('open-url', (event, url) => {
        event.preventDefault();
        console.log('[Protocol] Received URL via open-url:', url);
        
        if (!url || !url.startsWith('pickleglass://')) {
            console.warn('[Protocol] Invalid URL format:', url);
            return;
        }

        if (app.isReady()) {
            handleCustomUrl(url);
        } else {
            pendingDeepLinkUrl = url;
            console.log('[Protocol] App not ready, storing URL for later');
        }
    });
}

function focusMainWindow() {
    const { windowPool } = require('./electron/windowManager');
    if (windowPool) {
        const header = windowPool.get('header');
        if (header && !header.isDestroyed()) {
            if (header.isMinimized()) header.restore();
            header.focus();
            return true;
        }
    }
    
    // Fallback: focus any available window
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
        const mainWindow = windows[0];
        if (!mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
            return true;
        }
    }
    
    return false;
}

if (process.platform === 'win32') {
    for (const arg of process.argv) {
        if (arg && typeof arg === 'string' && arg.startsWith('pickleglass://')) {
            // Clean up the URL by removing problematic characters (korean characters issue...)
            const cleanUrl = arg.replace(/[\\₩]/g, '');
            
            if (!cleanUrl.includes(':') || cleanUrl.indexOf('://') === cleanUrl.lastIndexOf(':')) {
                console.log('[Protocol] Found protocol URL in initial arguments:', cleanUrl);
                pendingDeepLinkUrl = cleanUrl;
                break;
            }
        }
    }
    
    console.log('[Protocol] Initial process.argv:', process.argv);
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
    process.exit(0);
}

// setup protocol after single instance lock
setupProtocolHandling();

app.whenReady().then(async () => {

    // Setup native loopback audio capture for Windows
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
        desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
            // Grant access to the first screen found with loopback audio
            callback({ video: sources[0], audio: 'loopback' });
        }).catch((error) => {
            console.error('Failed to get desktop capturer sources:', error);
            callback({});
        });
    });

    // Initialize core services
    initializeFirebase();
    
    try {
        await databaseInitializer.initialize();
        console.log('>>> [index.js] Database initialized successfully');
        
        // Clean up zombie sessions from previous runs first - MOVED TO authService
        // sessionRepository.endAllActiveSessions();

        await authService.initialize();

        //////// after_modelStateService ////////
        await modelStateService.initialize();
        //////// after_modelStateService ////////

        listenService.setupIpcHandlers();
        askService.initialize();
        settingsService.initialize();
        setupGeneralIpcHandlers();
        setupOllamaIpcHandlers();
        setupWhisperIpcHandlers();

        // Initialize Ollama models in database
        await ollamaModelRepository.initializeDefaultModels();

        // Auto warm-up selected Ollama model in background (non-blocking)
        setTimeout(async () => {
            try {
                console.log('[index.js] Starting background Ollama model warm-up...');
                await ollamaService.autoWarmUpSelectedModel();
            } catch (error) {
                console.log('[index.js] Background warm-up failed (non-critical):', error.message);
            }
        }, 2000); // Wait 2 seconds after app start

        // Start web server and create windows ONLY after all initializations are successful
        WEB_PORT = await startWebStack();
        console.log('Web front-end listening on', WEB_PORT);
        
        createWindows();

    } catch (err) {
        console.error('>>> [index.js] Database initialization failed - some features may not work', err);
        // Optionally, show an error dialog to the user
        dialog.showErrorBox(
            'Application Error',
            'A critical error occurred during startup. Some features might be disabled. Please restart the application.'
        );
    }

    // initAutoUpdater should be called after auth is initialized
    initAutoUpdater();

    // Process any pending deep link after everything is initialized
    if (pendingDeepLinkUrl) {
        console.log('[Protocol] Processing pending URL:', pendingDeepLinkUrl);
        handleCustomUrl(pendingDeepLinkUrl);
        pendingDeepLinkUrl = null;
    }
});

app.on('window-all-closed', () => {
    listenService.stopMacOSAudioCapture();
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', async (event) => {
    // Prevent infinite loop by checking if shutdown is already in progress
    if (isShuttingDown) {
        console.log('[Shutdown] 🔄 Shutdown already in progress, allowing quit...');
        return;
    }
    
    console.log('[Shutdown] App is about to quit. Starting graceful shutdown...');
    
    // Set shutdown flag to prevent infinite loop
    isShuttingDown = true;
    
    // Prevent immediate quit to allow graceful shutdown
    event.preventDefault();
    
    try {
        // 1. Stop audio capture first (immediate)
        listenService.stopMacOSAudioCapture();
        console.log('[Shutdown] Audio capture stopped');
        
        // 2. End all active sessions (database operations) - with error handling
        try {
            await sessionRepository.endAllActiveSessions();
            console.log('[Shutdown] Active sessions ended');
        } catch (dbError) {
            console.warn('[Shutdown] Could not end active sessions (database may be closed):', dbError.message);
        }
        
        // 3. Shutdown Ollama service (potentially time-consuming)
        console.log('[Shutdown] shutting down Ollama service...');
        const ollamaShutdownSuccess = await Promise.race([
            ollamaService.shutdown(false), // Graceful shutdown
            new Promise(resolve => setTimeout(() => resolve(false), 8000)) // 8s timeout
        ]);
        
        if (ollamaShutdownSuccess) {
            console.log('[Shutdown] Ollama service shut down gracefully');
        } else {
            console.log('[Shutdown] Ollama shutdown timeout, forcing...');
            // Force shutdown if graceful failed
            try {
                await ollamaService.shutdown(true);
            } catch (forceShutdownError) {
                console.warn('[Shutdown] Force shutdown also failed:', forceShutdownError.message);
            }
        }
        
        // 4. Close database connections (final cleanup)
        try {
            databaseInitializer.close();
            console.log('[Shutdown] Database connections closed');
        } catch (closeError) {
            console.warn('[Shutdown] Error closing database:', closeError.message);
        }
        
        console.log('[Shutdown] Graceful shutdown completed successfully');
        
    } catch (error) {
        console.error('[Shutdown] Error during graceful shutdown:', error);
        // Continue with shutdown even if there were errors
    } finally {
        // Actually quit the app now
        console.log('[Shutdown] Exiting application...');
        app.exit(0); // Use app.exit() instead of app.quit() to force quit
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindows();
    }
});

function setupWhisperIpcHandlers() {
    const { WhisperService } = require('./common/services/whisperService');
    const whisperService = new WhisperService();
    
    // Forward download progress events to renderer
    whisperService.on('downloadProgress', (data) => {
        const windows = BrowserWindow.getAllWindows();
        windows.forEach(window => {
            window.webContents.send('whisper:download-progress', data);
        });
    });
    
    // IPC handlers for Whisper operations
    ipcMain.handle('whisper:download-model', async (event, modelId) => {
        try {
            console.log(`[Whisper IPC] Starting download for model: ${modelId}`);
            
            // Ensure WhisperService is initialized first
            if (!whisperService.isInitialized) {
                console.log('[Whisper IPC] Initializing WhisperService...');
                await whisperService.initialize();
            }
            
            // Set up progress listener
            const progressHandler = (data) => {
                if (data.modelId === modelId) {
                    event.sender.send('whisper:download-progress', data);
                }
            };
            
            whisperService.on('downloadProgress', progressHandler);
            
            try {
                await whisperService.ensureModelAvailable(modelId);
                console.log(`[Whisper IPC] Model ${modelId} download completed successfully`);
            } finally {
                // Cleanup listener
                whisperService.removeListener('downloadProgress', progressHandler);
            }
            
            return { success: true };
        } catch (error) {
            console.error(`[Whisper IPC] Failed to download model ${modelId}:`, error);
            return { success: false, error: error.message };
        }
    });
    
    ipcMain.handle('whisper:get-installed-models', async () => {
        try {
            // Ensure WhisperService is initialized first
            if (!whisperService.isInitialized) {
                console.log('[Whisper IPC] Initializing WhisperService for model list...');
                await whisperService.initialize();
            }
            
            const models = await whisperService.getInstalledModels();
            return { success: true, models };
        } catch (error) {
            console.error('[Whisper IPC] Failed to get installed models:', error);
            return { success: false, error: error.message };
        }
    });
}

function setupGeneralIpcHandlers() {
    const userRepository = require('./common/repositories/user');
    const presetRepository = require('./common/repositories/preset');

    ipcMain.handle('save-api-key', (event, apiKey) => {
        try {
            // The adapter injects the UID and handles local/firebase logic.
            // Assuming a default provider if not specified.
            userRepository.saveApiKey(apiKey, 'openai');
            BrowserWindow.getAllWindows().forEach(win => {
                win.webContents.send('api-key-updated');
            });
            return { success: true };
        } catch (error) {
            console.error('IPC: Failed to save API key:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('get-user-presets', () => {
        // The adapter injects the UID.
        return presetRepository.getPresets();
    });

    ipcMain.handle('get-preset-templates', () => {
        return presetRepository.getPresetTemplates();
    });

    ipcMain.handle('start-firebase-auth', async () => {
        try {
            const authUrl = `http://localhost:${WEB_PORT}/login?mode=electron`;
            console.log(`[Auth] Opening Firebase auth URL in browser: ${authUrl}`);
            await shell.openExternal(authUrl);
            return { success: true };
        } catch (error) {
            console.error('[Auth] Failed to open Firebase auth URL:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('get-web-url', () => {
        return process.env.pickleglass_WEB_URL || 'http://localhost:3000';
    });

    ipcMain.handle('get-current-user', () => {
        return authService.getCurrentUser();
    });

    // --- Web UI Data Handlers (New) ---
    setupWebDataHandlers();
}

function setupOllamaIpcHandlers() {
    // Ollama status and installation
    ipcMain.handle('ollama:get-status', async () => {
        try {
            const installed = await ollamaService.isInstalled();
            const running = installed ? await ollamaService.isServiceRunning() : false;
            const models = await ollamaService.getAllModelsWithStatus();
            
            return { 
                installed, 
                running, 
                models,
                success: true 
            };
        } catch (error) {
            console.error('[Ollama IPC] Failed to get status:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('ollama:install', async (event) => {
        try {
            const onProgress = (data) => {
                event.sender.send('ollama:install-progress', data);
            };

            await ollamaService.autoInstall(onProgress);
            
            if (!await ollamaService.isServiceRunning()) {
                onProgress({ stage: 'starting', message: 'Starting Ollama service...', progress: 0 });
                await ollamaService.startService();
                onProgress({ stage: 'starting', message: 'Ollama service started.', progress: 100 });
            }
            event.sender.send('ollama:install-complete', { success: true });
            return { success: true };
        } catch (error) {
            console.error('[Ollama IPC] Failed to install:', error);
            event.sender.send('ollama:install-complete', { success: false, error: error.message });
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('ollama:start-service', async (event) => {
        try {
            if (!await ollamaService.isServiceRunning()) {
                console.log('[Ollama IPC] Starting Ollama service...');
                await ollamaService.startService();
            }
            event.sender.send('ollama:install-complete', { success: true });
            return { success: true };
        } catch (error) {
            console.error('[Ollama IPC] Failed to start service:', error);
            event.sender.send('ollama:install-complete', { success: false, error: error.message });
            return { success: false, error: error.message };
        }
    });

    // Ensure Ollama is ready (starts service if installed but not running)
    ipcMain.handle('ollama:ensure-ready', async () => {
        try {
            if (await ollamaService.isInstalled() && !await ollamaService.isServiceRunning()) {
                console.log('[Ollama IPC] Ollama installed but not running, starting service...');
                await ollamaService.startService();
            }
            return { success: true };
        } catch (error) {
            console.error('[Ollama IPC] Failed to ensure ready:', error);
            return { success: false, error: error.message };
        }
    });

    // Get all models with their status
    ipcMain.handle('ollama:get-models', async () => {
        try {
            const models = await ollamaService.getAllModelsWithStatus();
            return { success: true, models };
        } catch (error) {
            console.error('[Ollama IPC] Failed to get models:', error);
            return { success: false, error: error.message };
        }
    });

    // Get model suggestions for autocomplete
    ipcMain.handle('ollama:get-model-suggestions', async () => {
        try {
            const suggestions = await ollamaService.getModelSuggestions();
            return { success: true, suggestions };
        } catch (error) {
            console.error('[Ollama IPC] Failed to get model suggestions:', error);
            return { success: false, error: error.message };
        }
    });

    // Pull/install a specific model
    ipcMain.handle('ollama:pull-model', async (event, modelName) => {
        try {
            console.log(`[Ollama IPC] Starting model pull: ${modelName}`);
            
            // Update DB status to installing
            await ollamaModelRepository.updateInstallStatus(modelName, false, true);
            
            // Set up progress listener for real-time updates
            const progressHandler = (data) => {
                if (data.model === modelName) {
                    event.sender.send('ollama:pull-progress', data);
                }
            };
            
            const completeHandler = (data) => {
                if (data.model === modelName) {
                    console.log(`[Ollama IPC] Model ${modelName} pull completed`);
                    // Clean up listeners
                    ollamaService.removeListener('pull-progress', progressHandler);
                    ollamaService.removeListener('pull-complete', completeHandler);
                }
            };
            
            ollamaService.on('pull-progress', progressHandler);
            ollamaService.on('pull-complete', completeHandler);
            
            // Pull the model using REST API
            await ollamaService.pullModel(modelName);
            
            // Update DB status to installed
            await ollamaModelRepository.updateInstallStatus(modelName, true, false);
            
            console.log(`[Ollama IPC] Model ${modelName} pull successful`);
            return { success: true };
        } catch (error) {
            console.error('[Ollama IPC] Failed to pull model:', error);
            // Reset status on error
            await ollamaModelRepository.updateInstallStatus(modelName, false, false);
            return { success: false, error: error.message };
        }
    });

    // Check if a specific model is installed
    ipcMain.handle('ollama:is-model-installed', async (event, modelName) => {
        try {
            const installed = await ollamaService.isModelInstalled(modelName);
            return { success: true, installed };
        } catch (error) {
            console.error('[Ollama IPC] Failed to check model installation:', error);
            return { success: false, error: error.message };
        }
    });

    // Warm up a specific model
    ipcMain.handle('ollama:warm-up-model', async (event, modelName) => {
        try {
            const success = await ollamaService.warmUpModel(modelName);
            return { success };
        } catch (error) {
            console.error('[Ollama IPC] Failed to warm up model:', error);
            return { success: false, error: error.message };
        }
    });

    // Auto warm-up currently selected model
    ipcMain.handle('ollama:auto-warm-up', async () => {
        try {
            const success = await ollamaService.autoWarmUpSelectedModel();
            return { success };
        } catch (error) {
            console.error('[Ollama IPC] Failed to auto warm-up:', error);
            return { success: false, error: error.message };
        }
    });

    // Get warm-up status for debugging
    ipcMain.handle('ollama:get-warm-up-status', async () => {
        try {
            const status = ollamaService.getWarmUpStatus();
            return { success: true, status };
        } catch (error) {
            console.error('[Ollama IPC] Failed to get warm-up status:', error);
            return { success: false, error: error.message };
        }
    });

    // Shutdown Ollama service manually
    ipcMain.handle('ollama:shutdown', async (event, force = false) => {
        try {
            console.log(`[Ollama IPC] Manual shutdown requested (force: ${force})`);
            const success = await ollamaService.shutdown(force);
            return { success };
        } catch (error) {
            console.error('[Ollama IPC] Failed to shutdown Ollama:', error);
            return { success: false, error: error.message };
        }
    });

    console.log('[Ollama IPC] Handlers registered');
}

function setupWebDataHandlers() {
    const sessionRepository = require('./common/repositories/session');
    const sttRepository = require('./features/listen/stt/repositories');
    const summaryRepository = require('./features/listen/summary/repositories');
    const askRepository = require('./features/ask/repositories');
    const userRepository = require('./common/repositories/user');
    const presetRepository = require('./common/repositories/preset');

    const handleRequest = async (channel, responseChannel, payload) => {
        let result;
        // const currentUserId = authService.getCurrentUserId(); // No longer needed here
        try {
            switch (channel) {
                // SESSION
                case 'get-sessions':
                    // Adapter injects UID
                    result = await sessionRepository.getAllByUserId();
                    break;
                case 'get-session-details':
                    const session = await sessionRepository.getById(payload);
                    if (!session) {
                        result = null;
                        break;
                    }
                    const [transcripts, ai_messages, summary] = await Promise.all([
                        sttRepository.getAllTranscriptsBySessionId(payload),
                        askRepository.getAllAiMessagesBySessionId(payload),
                        summaryRepository.getSummaryBySessionId(payload)
                    ]);
                    result = { session, transcripts, ai_messages, summary };
                    break;
                case 'delete-session':
                    result = await sessionRepository.deleteWithRelatedData(payload);
                    break;
                case 'create-session':
                    // Adapter injects UID
                    const id = await sessionRepository.create('ask');
                    if (payload && payload.title) {
                        await sessionRepository.updateTitle(id, payload.title);
                    }
                    result = { id };
                    break;
                
                // USER
                case 'get-user-profile':
                    // Adapter injects UID
                    result = await userRepository.getById();
                    break;
                case 'update-user-profile':
                     // Adapter injects UID
                    result = await userRepository.update(payload);
                    break;
                case 'find-or-create-user':
                    result = await userRepository.findOrCreate(payload);
                    break;
                case 'save-api-key':
                    // Assuming payload is { apiKey, provider }
                    result = await userRepository.saveApiKey(payload.apiKey, payload.provider);
                    break;
                case 'check-api-key-status':
                    // Adapter injects UID
                    const user = await userRepository.getById();
                    result = { hasApiKey: !!user?.api_key && user.api_key.length > 0 };
                    break;
                case 'delete-account':
                    // Adapter injects UID
                    result = await userRepository.deleteById();
                    break;

                // PRESET
                case 'get-presets':
                    // Adapter injects UID
                    result = await presetRepository.getPresets();
                    break;
                case 'create-preset':
                    // Adapter injects UID
                    result = await presetRepository.create(payload);
                    settingsService.notifyPresetUpdate('created', result.id, payload.title);
                    break;
                case 'update-preset':
                    // Adapter injects UID
                    result = await presetRepository.update(payload.id, payload.data);
                    settingsService.notifyPresetUpdate('updated', payload.id, payload.data.title);
                    break;
                case 'delete-preset':
                    // Adapter injects UID
                    result = await presetRepository.delete(payload);
                    settingsService.notifyPresetUpdate('deleted', payload);
                    break;
                
                // BATCH
                case 'get-batch-data':
                    const includes = payload ? payload.split(',').map(item => item.trim()) : ['profile', 'presets', 'sessions'];
                    const promises = {};
            
                    if (includes.includes('profile')) {
                        // Adapter injects UID
                        promises.profile = userRepository.getById();
                    }
                    if (includes.includes('presets')) {
                        // Adapter injects UID
                        promises.presets = presetRepository.getPresets();
                    }
                    if (includes.includes('sessions')) {
                        // Adapter injects UID
                        promises.sessions = sessionRepository.getAllByUserId();
                    }
                    
                    const batchResult = {};
                    const promiseResults = await Promise.all(Object.values(promises));
                    Object.keys(promises).forEach((key, index) => {
                        batchResult[key] = promiseResults[index];
                    });

                    result = batchResult;
                    break;

                default:
                    throw new Error(`Unknown web data channel: ${channel}`);
            }
            eventBridge.emit(responseChannel, { success: true, data: result });
        } catch (error) {
            console.error(`Error handling web data request for ${channel}:`, error);
            eventBridge.emit(responseChannel, { success: false, error: error.message });
        }
    };
    
    eventBridge.on('web-data-request', handleRequest);
}

async function handleCustomUrl(url) {
    try {
        console.log('[Custom URL] Processing URL:', url);
        
        // Validate and clean URL
        if (!url || typeof url !== 'string' || !url.startsWith('pickleglass://')) {
            console.error('[Custom URL] Invalid URL format:', url);
            return;
        }
        
        // Clean up URL by removing problematic characters
        const cleanUrl = url.replace(/[\\₩]/g, '');
        
        // Additional validation
        if (cleanUrl !== url) {
            console.log('[Custom URL] Cleaned URL from:', url, 'to:', cleanUrl);
            url = cleanUrl;
        }
        
        const urlObj = new URL(url);
        const action = urlObj.hostname;
        const params = Object.fromEntries(urlObj.searchParams);
        
        console.log('[Custom URL] Action:', action, 'Params:', params);

        switch (action) {
            case 'login':
            case 'auth-success':
                await handleFirebaseAuthCallback(params);
                break;
            case 'personalize':
                handlePersonalizeFromUrl(params);
                break;
            default:
                const { windowPool } = require('./electron/windowManager');
                const header = windowPool.get('header');
                if (header) {
                    if (header.isMinimized()) header.restore();
                    header.focus();
                    
                    const targetUrl = `http://localhost:${WEB_PORT}/${action}`;
                    console.log(`[Custom URL] Navigating webview to: ${targetUrl}`);
                    header.webContents.loadURL(targetUrl);
                }
        }

    } catch (error) {
        console.error('[Custom URL] Error parsing URL:', error);
    }
}

async function handleFirebaseAuthCallback(params) {
    const userRepository = require('./common/repositories/user');
    const { token: idToken } = params;

    if (!idToken) {
        console.error('[Auth] Firebase auth callback is missing ID token.');
        // No need to send IPC, the UI won't transition without a successful auth state change.
        return;
    }

    console.log('[Auth] Received ID token from deep link, exchanging for custom token...');

    try {
        const functionUrl = 'https://us-west1-pickle-3651a.cloudfunctions.net/pickleGlassAuthCallback';
        const response = await fetch(functionUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: idToken })
        });

        const data = await response.json();

        if (!response.ok || !data.success) {
            throw new Error(data.error || 'Failed to exchange token.');
        }

        const { customToken, user } = data;
        console.log('[Auth] Successfully received custom token for user:', user.uid);

        const firebaseUser = {
            uid: user.uid,
            email: user.email || 'no-email@example.com',
            displayName: user.name || 'User',
            photoURL: user.picture
        };

        // 1. Sync user data to local DB
        userRepository.findOrCreate(firebaseUser);
        console.log('[Auth] User data synced with local DB.');

        // 2. Sign in using the authService in the main process
        await authService.signInWithCustomToken(customToken);
        console.log('[Auth] Main process sign-in initiated. Waiting for onAuthStateChanged...');

        // 3. Focus the app window
        const { windowPool } = require('./electron/windowManager');
        const header = windowPool.get('header');
        if (header) {
            if (header.isMinimized()) header.restore();
            header.focus();
        } else {
            console.error('[Auth] Header window not found after auth callback.');
        }
        
    } catch (error) {
        console.error('[Auth] Error during custom token exchange or sign-in:', error);
        // The UI will not change, and the user can try again.
        // Optionally, send a generic error event to the renderer.
        const { windowPool } = require('./electron/windowManager');
        const header = windowPool.get('header');
        if (header) {
            header.webContents.send('auth-failed', { message: error.message });
        }
    }
}

function handlePersonalizeFromUrl(params) {
    console.log('[Custom URL] Personalize params:', params);
    
    const { windowPool } = require('./electron/windowManager');
    const header = windowPool.get('header');
    
    if (header) {
        if (header.isMinimized()) header.restore();
        header.focus();
        
        const personalizeUrl = `http://localhost:${WEB_PORT}/settings`;
        console.log(`[Custom URL] Navigating to personalize page: ${personalizeUrl}`);
        header.webContents.loadURL(personalizeUrl);
        
        BrowserWindow.getAllWindows().forEach(win => {
            win.webContents.send('enter-personalize-mode', {
                message: 'Personalization mode activated',
                params: params
            });
        });
    } else {
        console.error('[Custom URL] Header window not found for personalize');
    }
}


async function startWebStack() {
  console.log('NODE_ENV =', process.env.NODE_ENV); 
  const isDev = !app.isPackaged;

  const getAvailablePort = () => {
    return new Promise((resolve, reject) => {
      const server = require('net').createServer();
      server.listen(0, (err) => {
        if (err) reject(err);
        const port = server.address().port;
        server.close(() => resolve(port));
      });
    });
  };

  const apiPort = await getAvailablePort();
  const frontendPort = await getAvailablePort();

  console.log(`🔧 Allocated ports: API=${apiPort}, Frontend=${frontendPort}`);

  process.env.pickleglass_API_PORT = apiPort.toString();
  process.env.pickleglass_API_URL = `http://localhost:${apiPort}`;
  process.env.pickleglass_WEB_PORT = frontendPort.toString();
  process.env.pickleglass_WEB_URL = `http://localhost:${frontendPort}`;

  console.log(`🌍 Environment variables set:`, {
    pickleglass_API_URL: process.env.pickleglass_API_URL,
    pickleglass_WEB_URL: process.env.pickleglass_WEB_URL
  });

  const createBackendApp = require('../pickleglass_web/backend_node');
  const nodeApi = createBackendApp(eventBridge);

  const staticDir = app.isPackaged
    ? path.join(process.resourcesPath, 'out')
    : path.join(__dirname, '..', 'pickleglass_web', 'out');

  const fs = require('fs');

  if (!fs.existsSync(staticDir)) {
    console.error(`============================================================`);
    console.error(`[ERROR] Frontend build directory not found!`);
    console.error(`Path: ${staticDir}`);
    console.error(`Please run 'npm run build' inside the 'pickleglass_web' directory first.`);
    console.error(`============================================================`);
    app.quit();
    return;
  }

  const runtimeConfig = {
    API_URL: `http://localhost:${apiPort}`,
    WEB_URL: `http://localhost:${frontendPort}`,
    timestamp: Date.now()
  };
  
    // Create a runtime configuration file in a writable temporary folder
  const tempDir = app.getPath('temp');
  const configPath = path.join(tempDir, 'runtime-config.json');
  fs.writeFileSync(configPath, JSON.stringify(runtimeConfig, null, 2));
  console.log(`📝 Runtime config created in temp location: ${configPath}`);

  const frontSrv = express();
  
    // Frontend requests /runtime-config.json, so we provide the file from the temporary folder
  frontSrv.get('/runtime-config.json', (req, res) => {
    res.sendFile(configPath);
  });

  frontSrv.use((req, res, next) => {
    if (req.path.indexOf('.') === -1 && req.path !== '/') {
      const htmlPath = path.join(staticDir, req.path + '.html');
      if (fs.existsSync(htmlPath)) {
        return res.sendFile(htmlPath);
      }
    }
    next();
  });
  
  frontSrv.use(express.static(staticDir));
  
  const frontendServer = await new Promise((resolve, reject) => {
    const server = frontSrv.listen(frontendPort, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
    app.once('before-quit', () => server.close());
  });

  console.log(`✅ Frontend server started on http://localhost:${frontendPort}`);

  const apiSrv = express();
  apiSrv.use(nodeApi);

  const apiServer = await new Promise((resolve, reject) => {
    const server = apiSrv.listen(apiPort, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
    app.once('before-quit', () => server.close());
  });

  console.log(`✅ API server started on http://localhost:${apiPort}`);

  console.log(`🚀 All services ready:`);
  console.log(`   Frontend: http://localhost:${frontendPort}`);
  console.log(`   API:      http://localhost:${apiPort}`);

  return frontendPort;
}

// Auto-update initialization
async function initAutoUpdater() {
    try {
        const autoUpdateEnabled = await settingsService.getAutoUpdateSetting();
        if (!autoUpdateEnabled) {
            console.log('[AutoUpdater] Skipped because auto-updates are disabled in settings');
            return;
        }
        // Skip auto-updater in development mode
        if (!app.isPackaged) {
            console.log('[AutoUpdater] Skipped in development (app is not packaged)');
            return;
        }

        autoUpdater.setFeedURL({
            provider: 'github',
            owner: 'pickle-com',
            repo: 'glass',
        });

        // Immediately check for updates & notify
        autoUpdater.checkForUpdatesAndNotify()
            .catch(err => {
                console.error('[AutoUpdater] Error checking for updates:', err);
            });

        autoUpdater.on('checking-for-update', () => {
            console.log('[AutoUpdater] Checking for updates…');
        });

        autoUpdater.on('update-available', (info) => {
            console.log('[AutoUpdater] Update available:', info.version);
        });

        autoUpdater.on('update-not-available', () => {
            console.log('[AutoUpdater] Application is up-to-date');
        });

        autoUpdater.on('error', (err) => {
            console.error('[AutoUpdater] Error while updating:', err);
        });

        autoUpdater.on('update-downloaded', (info) => {
            console.log(`[AutoUpdater] Update downloaded: ${info.version}`);

            const dialogOpts = {
                type: 'info',
                buttons: ['Install now', 'Install on next launch'],
                title: 'Update Available',
                message: 'A new version of Glass is ready to be installed.',
                defaultId: 0,
                cancelId: 1
            };

            dialog.showMessageBox(dialogOpts).then((returnValue) => {
                // returnValue.response 0 is for 'Install Now'
                if (returnValue.response === 0) {
                    autoUpdater.quitAndInstall();
                }
            });
        });
    } catch (e) {
        console.error('[AutoUpdater] Failed to initialise:', e);
    }
}