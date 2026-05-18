const { app, BrowserWindow, Tray, Menu, ipcMain, clipboard } = require('electron');
const path = require('path');
const Store = require('electron-store');
const { SerialPort } = require('serialport');
const fs = require('fs');
const { StringDecoder } = require('string_decoder');

function logError(errorMsg) {
  try {
    const logPath = path.join(app.getPath('userData'), 'error.log');
    const time = new Date().toISOString();
    fs.appendFileSync(logPath, `[${time}] ERROR: ${errorMsg}\n`);
  } catch (e) {
    console.error('Cannot write log:', e);
  }
}

const store = new Store({
  defaults: {
    port: '',
    baudRate: 9600,
    dataBits: 8,
    parity: 'none',
    stopBits: 1,
    encoding: 'utf8',
    startWithWindows: true,
    autoReconnect: true,
    reconnectIntervalSeconds: 10
  }
});

let mainWindow;
let tray = null;
let serialPort = null;
let reconnectTimer = null;
let autoLauncher = null;
let currentStatus = { connected: false, message: 'Đang khởi động...' };

function broadcastStatus(status) {
  currentStatus = { ...currentStatus, ...status };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status-update', currentStatus);
  }
}

function setupAutoLaunch() {
  const enabled = store.get('startWithWindows');
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: app.getPath('exe'),
    args: [
      '--hidden'
    ]
  });
}

function parseCCCDData(rawString) {
  // Giữ nguyên chuỗi gốc (raw) có chứa dấu | theo đúng yêu cầu người dùng
  return rawString.trim();
}

function connectSerialPort(config) {
  if (serialPort && serialPort.isOpen) {
    serialPort.close();
  }

  if (reconnectTimer) {
    clearInterval(reconnectTimer);
    reconnectTimer = null;
  }

  if (!config.port) {
    broadcastStatus({ connected: false, message: 'Chưa chọn cổng COM' });
    startReconnectLoop();
    return;
  }

  const displayName = config.deviceName ? `${config.port} (${config.deviceName})` : config.port;
  broadcastStatus({ connected: false, message: `Đang kết nối ${displayName}...` });

  try {
    serialPort = new SerialPort({
      path: config.port,
      baudRate: parseInt(config.baudRate) || 9600,
      dataBits: parseInt(config.dataBits) || 8,
      parity: config.parity.toLowerCase(),
      stopBits: parseFloat(config.stopBits) || 1,
      autoOpen: false
    });

    serialPort.open((err) => {
      if (err) {
        logError('Error opening port ' + config.port + ': ' + err.message);
        broadcastStatus({ connected: false, message: `Lỗi kết nối: ${err.message}` });
        startReconnectLoop();
        return;
      }
      broadcastStatus({ connected: true, message: `Đã kết nối ${displayName}` });
    });

    let buffer = '';
    let scanTimeout = null;
    let decoder = new StringDecoder(config.encoding === 'ascii' ? 'ascii' : 'utf8');

    function processBuffer() {
      if (!buffer) return;
      const remaining = decoder.end();
      if (remaining) buffer += remaining;

      const completeData = buffer.trim();
      buffer = ''; // Reset buffer sau khi xử lý
      decoder = new StringDecoder(config.encoding === 'ascii' ? 'ascii' : 'utf8'); // Khởi tạo lại decoder cho lần quét tiếp theo

      if (completeData) {
        const formatted = parseCCCDData(completeData);
        clipboard.writeText(formatted);
        
        // Tự động gõ phím dán (Ctrl + V) vào ứng dụng đang focus kèm phím Enter
        try {
          const robot = require('robotjs');
          // Tăng delay sau khi ghi clipboard lên 150ms để Windows và các phần mềm nặng kịp đồng bộ dữ liệu trong bộ nhớ
          setTimeout(() => {
            robot.keyTap('v', ['control']);
            // Tăng delay trước khi gõ Enter lên 250ms để phần mềm đích có đủ thời gian xử lý và hiển thị trọn vẹn chuỗi Unicode tiếng Việt
            setTimeout(() => { robot.keyTap('enter'); }, 250);
          }, 150);
        } catch (e) {
          logError('Robotjs error: ' + e.message);
        }

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('scan-result', { raw: completeData, formatted, time: new Date().toLocaleTimeString() });
        }
      }
    }

    serialPort.on('data', (data) => {
      // Sử dụng StringDecoder để giải mã chính xác các ký tự UTF-8 nhiều byte bị cắt ngang giữa các chunk
      const text = decoder.write(data);
      buffer += text;
      
      // Xóa timer cũ nếu dữ liệu đang tiếp tục đến
      if (scanTimeout) clearTimeout(scanTimeout);

      // Nếu phát hiện ký tự xuống dòng, xử lý ngay
      if (buffer.includes('\n') || buffer.includes('\r')) {
        processBuffer();
      } else {
        // Giảm thời gian chờ ngắt gói dữ liệu từ 200ms xuống 40ms (tăng tốc độ phản hồi lên gấp 5 lần)
        scanTimeout = setTimeout(processBuffer, 40);
      }
    });

    serialPort.on('close', () => {
      broadcastStatus({ connected: false, message: `Mất kết nối ${config.port}. Đang thử lại...` });
      startReconnectLoop();
    });

    serialPort.on('error', (err) => {
      logError('Serial port error: ' + err.message);
      broadcastStatus({ connected: false, message: `Lỗi cổng: ${err.message}` });
      startReconnectLoop();
    });

  } catch (err) {
    logError('Connection initialization error: ' + err.message);
    broadcastStatus({ connected: false, message: `Lỗi khởi tạo: ${err.message}` });
    startReconnectLoop();
  }
}

function startReconnectLoop() {
  const config = store.store;
  if (!config.autoReconnect) return;

  if (!reconnectTimer) {
    reconnectTimer = setInterval(async () => {
      if (serialPort && serialPort.isOpen) {
        clearInterval(reconnectTimer);
        reconnectTimer = null;
        return;
      }

      broadcastStatus({ connected: false, message: `Đang tìm cổng ${config.port || 'COM'}...` });
      try {
        const ports = await SerialPort.list();
        // Ưu tiên tìm theo cổng COM đã lưu
        let found = ports.find(p => p.path === config.port);
        
        // Cấp 2: Tìm theo ID phần cứng cực kỳ chính xác (Vendor ID & Product ID)
        if (!found && config.vendorId && config.productId) {
          found = ports.find(p => p.vendorId === config.vendorId && p.productId === config.productId);
        }

        // Cấp 3: Nếu không thấy cổng COM cũ nhưng có lưu tên thiết bị, thử tìm theo tên
        if (!found && config.deviceName) {
          found = ports.find(p => p.friendlyName && p.friendlyName.includes(config.deviceName));
        }

        // Nếu tìm thấy bằng mọi cách ở trên -> Update và nối
        if (found) {
          if (found.path !== config.port) {
            config.port = found.path;
            store.set('port', found.path);
          }
          connectSerialPort(config);
        }
      } catch (e) {
        logError('Error listing ports in loop: ' + e.message);
      }
    }, (config.reconnectIntervalSeconds || 10) * 1000);
  }
}

function createWindow() {
  const isHiddenStartup = process.argv.includes('--hidden');

  mainWindow = new BrowserWindow({
    width: 480,
    height: 175,
    show: !isHiddenStartup, // Chỉ hiện hộp thoại nếu KHÔNG phải do Windows tự bật
    resizable: false,
    frame: false,
    transparent: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    },
    icon: path.join(__dirname, 'assets', 'icon.png')
  });

  mainWindow.loadFile('renderer/index.html');

  mainWindow.webContents.on('did-finish-load', () => {
    broadcastStatus(currentStatus);
  });
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  tray = new Tray(iconPath);
  tray.setToolTip('CCCD Scanner');

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Mở bảng điều khiển', click: () => mainWindow.show() },
    { type: 'separator' },
    { label: 'Thoát', click: () => { app.isQuiting = true; app.quit(); } }
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    mainWindow.show();
  });
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    // Có người cố gắng mở app lần thứ 2, thay vì mở mới thì ta hiện cái cũ lên
    if (mainWindow) {
      if (!mainWindow.isVisible()) mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    setupAutoLaunch();
    createWindow();
    createTray();

    // Khởi động kết nối ban đầu
    const config = store.store;
    const ports = await SerialPort.list();
    let found = ports.find(p => p.path === config.port);
    
    // Cấp 2: Tìm theo phần cứng
    if (!found && config.vendorId && config.productId) {
      found = ports.find(p => p.vendorId === config.vendorId && p.productId === config.productId);
    }

    // Cấp 3: Tìm theo tên thiết bị nếu đổi cổng
    if (!found && config.deviceName) {
      found = ports.find(p => p.friendlyName && p.friendlyName.includes(config.deviceName));
    }

    if (found) {
      if (found.path !== config.port) {
        config.port = found.path;
        store.set('port', found.path);
      }
      connectSerialPort(config);
    } else {
      broadcastStatus({ connected: false, message: `Không tìm thấy cổng ${config.port || '(Chưa chọn)'}` });
      startReconnectLoop();
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

// Chế độ ẩn xuống khay hệ thống khi đóng
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Không quit, để chạy ngầm
  }
});

// IPC Handlers
ipcMain.handle('list-ports', async () => {
  try {
    return await SerialPort.list();
  } catch (e) {
    return [];
  }
});

ipcMain.handle('connect', (event, cfg) => {
  store.set(cfg);
  connectSerialPort(cfg);
  return currentStatus;
});

ipcMain.handle('disconnect', () => {
  if (serialPort && serialPort.isOpen) {
    serialPort.close();
  }
  if (reconnectTimer) {
    clearInterval(reconnectTimer);
    reconnectTimer = null;
  }
  broadcastStatus({ connected: false, message: 'Đã ngắt kết nối' });
  return currentStatus;
});

ipcMain.handle('save-config', (event, cfg) => {
  store.set(cfg);
  connectSerialPort(cfg);
  return store.store;
});

ipcMain.handle('get-config', () => {
  return store.store;
});

ipcMain.handle('hide-window', () => {
  if (mainWindow) mainWindow.hide();
});

ipcMain.handle('exit-app', () => {
  app.isQuiting = true;
  app.quit();
});

ipcMain.handle('resize-window', (event, width, height) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setResizable(true);
    mainWindow.setSize(width, height);
    mainWindow.setResizable(false);
  }
});
