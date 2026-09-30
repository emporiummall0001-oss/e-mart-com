import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { initialStoreData } from './src/data/initialStoreData.ts';
import { CODOrder, Product, StoreState } from './src/types/store.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const AUTH_FILE = path.join(DATA_DIR, 'admin-auth.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadStoreState(): StoreState {
  ensureDataDir();
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw = fs.readFileSync(STORE_FILE, 'utf-8');
      const parsed = JSON.parse(raw) as StoreState;
      if (parsed && parsed.products && parsed.banners && parsed.settings) {
        const demoIds = new Set(['ord-1001', 'ord-1002', 'ord-1003', 'ord-1004', 'ord-1005']);
        parsed.orders = (parsed.orders || []).filter((o) => !demoIds.has(o.id));
        parsed.demoBaseline = {
          enabled: false,
          extraTotalOrders: 0,
          extraDeliveredOrders: 0,
          extraReturnedOrders: 0,
          extraPendingOrders: 0,
          extraSalesAmount: 0,
        };
        if (!parsed.updatedAt) {
          parsed.updatedAt = Date.now();
        }
        return parsed;
      }
    }
  } catch (err) {
    console.error('Failed to read store.json, falling back to initialStoreData:', err);
  }
  const initial: StoreState = {
    ...structuredClone(initialStoreData),
    updatedAt: Date.now(),
  };
  fs.writeFileSync(STORE_FILE, JSON.stringify(initial, null, 2), 'utf-8');
  return initial;
}

function saveStoreState(state: StoreState) {
  ensureDataDir();
  state.updatedAt = Date.now();
  try {
    const tempFile = `${STORE_FILE}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tempFile, STORE_FILE);
  } catch (err) {
    try {
      fs.writeFileSync(STORE_FILE, JSON.stringify(state, null, 2), 'utf-8');
    } catch (innerErr) {
      console.error('Failed to write store.json:', innerErr || err);
    }
  }
}

function getAdminCredentials(): { username: string; password: string; isCustom?: boolean } {
  ensureDataDir();
  try {
    if (fs.existsSync(AUTH_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'));
      if (parsed && parsed.password) {
        return parsed;
      }
    }
  } catch {
    // ignore
  }
  const defaults = { username: 'admin', password: 'EMart#Admin2026!', isCustom: false };
  fs.writeFileSync(AUTH_FILE, JSON.stringify(defaults, null, 2), 'utf-8');
  return defaults;
}

function saveAdminCredentials(username: string, password: string) {
  ensureDataDir();
  fs.writeFileSync(
    AUTH_FILE,
    JSON.stringify({ username, password, isCustom: true }, null, 2),
    'utf-8'
  );
}

// Track active real-time sessions in memory + baseline organic shoppers
const activeSessions = new Map<string, number>();
const seenSessionsToday = new Set<string>();

function computeLiveVisitors(baseCount: number): number {
  const now = Date.now();
  for (const [sid, lastSeen] of activeSessions.entries()) {
    if (now - lastSeen > 120_000) {
      activeSessions.delete(sid);
    }
  }
  return Math.max(1, baseCount + activeSessions.size);
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Enable CORS & strict no-cache headers for all /api/* routes so Netlify and all devices sync live
  app.use('/api', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, Accept, Cache-Control, Pragma'
    );
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // Allow up to 50MB payload so 5 high-res product images + 3 banners upload smoothly from any device
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  let storeState: StoreState = loadStoreState();

  function getLiveStoreSnapshot(): StoreState {
    const currentLive = computeLiveVisitors(storeState.visitorStats.liveVisitors);
    return {
      ...storeState,
      visitorStats: {
        ...storeState.visitorStats,
        liveVisitors: currentLive,
      },
    };
  }

  // GET lightweight version & live visitor status for instant cross-device sync
  app.get('/api/store/version', (_req, res) => {
    const currentLive = computeLiveVisitors(storeState.visitorStats.liveVisitors);
    res.json({
      updatedAt: storeState.updatedAt || 0,
      liveVisitors: currentLive,
      todayVisitors: storeState.visitorStats.todayVisitors,
      totalVisitors: storeState.visitorStats.totalVisitors,
      productsCount: storeState.products.length,
      ordersCount: storeState.orders.length,
    });
  });

  // GET full centralized cloud store state
  app.get('/api/store', (_req, res) => {
    res.json(getLiveStoreSnapshot());
  });

  // POST visitor heartbeat
  app.post('/api/visitors/heartbeat', (req, res) => {
    const { sessionId, isNewVisit } = req.body || {};
    if (sessionId && typeof sessionId === 'string') {
      activeSessions.set(sessionId, Date.now());
      if (isNewVisit && !seenSessionsToday.has(sessionId)) {
        seenSessionsToday.add(sessionId);
        storeState.visitorStats.todayVisitors += 1;
        storeState.visitorStats.totalVisitors += 1;
        if (storeState.visitorStats.weeklyTraffic.length > 0) {
          const lastIdx = storeState.visitorStats.weeklyTraffic.length - 1;
          storeState.visitorStats.weeklyTraffic[lastIdx].visitors += 1;
        }
        saveStoreState(storeState);
      }
    }
    const currentLive = computeLiveVisitors(storeState.visitorStats.liveVisitors);
    res.json({
      updatedAt: storeState.updatedAt || 0,
      liveVisitors: currentLive,
      todayVisitors: storeState.visitorStats.todayVisitors,
      totalVisitors: storeState.visitorStats.totalVisitors,
    });
  });

  // PUT full or partial store state from Admin Portal
  app.put('/api/store', (req, res) => {
    const updated = req.body as Partial<StoreState>;
    if (!updated) {
      res.status(400).json({ error: 'Invalid payload' });
      return;
    }
    storeState = {
      ...storeState,
      ...updated,
      settings: updated.settings
        ? { ...storeState.settings, ...updated.settings }
        : storeState.settings,
      returnPolicy: updated.returnPolicy
        ? { ...storeState.returnPolicy, ...updated.returnPolicy }
        : storeState.returnPolicy,
    };
    saveStoreState(storeState);
    res.json(getLiveStoreSnapshot());
  });

  // POST add a single product to the cloud database
  app.post('/api/products', (req, res) => {
    const newProduct = req.body as Product;
    if (!newProduct || !newProduct.id || !newProduct.name) {
      res.status(400).json({ error: 'Invalid product payload' });
      return;
    }
    const existingIdx = storeState.products.findIndex((p) => p.id === newProduct.id);
    if (existingIdx >= 0) {
      storeState.products[existingIdx] = newProduct;
    } else {
      storeState.products = [newProduct, ...storeState.products];
    }
    saveStoreState(storeState);
    res.status(201).json({ product: newProduct, store: getLiveStoreSnapshot() });
  });

  // PUT update a single product in the cloud database
  app.put('/api/products/:id', (req, res) => {
    const { id } = req.params;
    const updatedProduct = req.body as Product;
    if (!updatedProduct || !updatedProduct.name) {
      res.status(400).json({ error: 'Invalid product payload' });
      return;
    }
    const idx = storeState.products.findIndex((p) => p.id === id);
    if (idx === -1) {
      storeState.products = [updatedProduct, ...storeState.products];
    } else {
      storeState.products[idx] = { ...storeState.products[idx], ...updatedProduct, id };
    }
    saveStoreState(storeState);
    res.json({ product: updatedProduct, store: getLiveStoreSnapshot() });
  });

  // DELETE a single product from the cloud database
  app.delete('/api/products/:id', (req, res) => {
    const { id } = req.params;
    storeState.products = storeState.products.filter((p) => p.id !== id);
    saveStoreState(storeState);
    res.json({ store: getLiveStoreSnapshot() });
  });

  // POST new Cash on Delivery order
  app.post('/api/orders', (req, res) => {
    const orderData = req.body as Omit<CODOrder, 'id' | 'orderNumber' | 'createdAt' | 'status'>;
    if (
      !orderData ||
      !orderData.customerName ||
      !orderData.customerAddress ||
      !orderData.productId
    ) {
      res.status(400).json({ error: 'Missing required COD order fields' });
      return;
    }

    const randomNum = Math.floor(1000 + Math.random() * 9000);
    const newOrder: CODOrder = {
      ...orderData,
      id: `ord-${Date.now()}`,
      orderNumber: `EM-${randomNum}`,
      status: 'Pending',
      createdAt: new Date().toISOString(),
    };

    storeState.orders = [newOrder, ...storeState.orders];

    if (storeState.visitorStats.weeklyTraffic.length > 0) {
      const lastIdx = storeState.visitorStats.weeklyTraffic.length - 1;
      storeState.visitorStats.weeklyTraffic[lastIdx].orders += 1;
      storeState.visitorStats.weeklyTraffic[lastIdx].sales +=
        Number(newOrder.totalAmount) || 0;
    }

    saveStoreState(storeState);
    res.status(201).json({ order: newOrder, store: getLiveStoreSnapshot() });
  });

  // PATCH order status
  app.patch('/api/orders/:id', (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    const idx = storeState.orders.findIndex((o) => o.id === id);
    if (idx === -1) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }
    storeState.orders[idx] = {
      ...storeState.orders[idx],
      status,
    };
    saveStoreState(storeState);
    res.json({ order: storeState.orders[idx], store: getLiveStoreSnapshot() });
  });

  // DELETE order
  app.delete('/api/orders/:id', (req, res) => {
    const { id } = req.params;
    storeState.orders = storeState.orders.filter((o) => o.id !== id);
    saveStoreState(storeState);
    res.json({ store: getLiveStoreSnapshot() });
  });

  // POST Admin Login
  app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body || {};
    const creds = getAdminCredentials();
    const enteredPass = typeof password === 'string' ? password.trim() : '';
    const cleanUser = (username || 'admin').trim().toLowerCase();
    const expectedUser = (storeState.settings.adminUsername || creds.username || 'admin')
      .trim()
      .toLowerCase();
    const validUser = !cleanUser || cleanUser === expectedUser || cleanUser === 'admin';

    const customPassword =
      storeState.settings.adminPassword || (creds.isCustom ? creds.password : '');

    const validPass = customPassword
      ? enteredPass === customPassword
      : enteredPass === 'EMart#Admin2026!' || enteredPass === 'emart2026';

    if (validUser && validPass && enteredPass.length > 0) {
      res.json({
        authenticated: true,
        username: storeState.settings.adminUsername || creds.username,
        token: `emart-admin-${Date.now()}`,
      });
      return;
    }
    res.status(401).json({
      authenticated: false,
      error: 'Incorrect admin username or password. Please try again.',
    });
  });

  // PUT Admin Password update
  app.put('/api/admin/password', (req, res) => {
    const { username, currentPassword, newPassword } = req.body || {};
    if (!newPassword || typeof newPassword !== 'string' || newPassword.trim().length < 4) {
      res.status(400).json({ error: 'New password must be at least 4 characters long.' });
      return;
    }
    const creds = getAdminCredentials();
    const activePass =
      storeState.settings.adminPassword || (creds.isCustom ? creds.password : '');

    if (
      currentPassword &&
      typeof currentPassword === 'string' &&
      currentPassword.trim().length > 0
    ) {
      const enteredCurrent = currentPassword.trim();
      const currentValid = activePass
        ? enteredCurrent === activePass
        : enteredCurrent === 'EMart#Admin2026!' || enteredCurrent === 'emart2026';
      if (!currentValid) {
        res.status(401).json({ error: 'Current password is incorrect.' });
        return;
      }
    }

    const updatedUser = username && username.trim() ? username.trim() : creds.username;
    const cleanNewPass = newPassword.trim();
    saveAdminCredentials(updatedUser, cleanNewPass);
    storeState.settings.adminUsername = updatedUser;
    storeState.settings.adminPassword = cleanNewPass;
    saveStoreState(storeState);
    res.json({
      success: true,
      username: updatedUser,
      store: getLiveStoreSnapshot(),
    });
  });

  // POST Reset to initial store data if requested
  app.post('/api/store/reset', (_req, res) => {
    storeState = {
      ...structuredClone(initialStoreData),
      updatedAt: Date.now(),
    };
    saveStoreState(storeState);
    res.json(getLiveStoreSnapshot());
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`E Mart Pakistan Cloud Server running at http://0.0.0.0:${PORT}`);
  });
}

startServer();
