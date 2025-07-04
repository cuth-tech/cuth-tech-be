import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import * as admin from 'firebase-admin';
import multer from 'multer';
import { parse } from 'csv-parse';
import fetch from 'node-fetch';

// Load environment variables
dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

// --- Configuration ---
app.use(cors());
app.use(express.json());
const upload = multer({ storage: multer.memoryStorage() });

// --- Firebase Initialization ---
try {
    const serviceAccountEnvVar = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!serviceAccountEnvVar) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON env var not set.");
    
    let serviceAccount: admin.ServiceAccount;
    try {
        serviceAccount = JSON.parse(serviceAccountEnvVar);
    } catch (e) {
        const decodedJson = Buffer.from(serviceAccountEnvVar, 'base64').toString('utf-8');
        serviceAccount = JSON.parse(decodedJson);
    }
    
    if (admin.apps.length === 0) {
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        console.log("Firebase Admin SDK initialized successfully.");
    }
} catch (error) {
    console.error("CRITICAL: Failed to initialize Firebase Admin SDK.", error);
    process.exit(1);
}

const db = admin.firestore();

// --- Helper Functions ---
const logToAudit = async (action: string, entityType: string, entityIdOrName: string, details: any = {}) => {
    try {
        await db.collection('auditLogs').add({
            action,
            entityType,
            entityIdOrName,
            details,
            timestamp: new Date().toISOString(),
        });
    } catch (error) {
        console.error("Failed to write to audit log:", error);
    }
};

// --- Generic Data Routes ---
app.get('/api/data/:filename', async (req, res) => {
    try {
        const { filename } = req.params;
        const doc = await db.collection('app_data').doc(filename).get();
        if (!doc.exists) return res.status(404).json({ message: 'Data not found.' });
        res.status(200).json(doc.data()?.content);
    } catch (error) { res.status(500).json({ message: 'Failed to fetch data.' }); }
});

app.post('/api/data/:filename', async (req, res) => {
    try {
        const { filename } = req.params;
        await db.collection('app_data').doc(filename).set({ content: req.body });
        res.status(200).json({ success: true, message: 'Data saved.' });
    } catch (error) { res.status(500).json({ success: false, message: 'Failed to save data.' }); }
});

// --- Product Routes ---
app.get('/api/products', async (req, res) => {
    try {
        const snapshot = await db.collection('products').get();
        const products = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        res.status(200).json(products);
    } catch (error) { res.status(500).json({ message: 'Failed to fetch products.' }); }
});

app.post('/api/products', async (req, res) => {
    try {
        const newProduct = { ...req.body, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        const docRef = await db.collection('products').add(newProduct);
        res.status(201).json({ id: docRef.id, ...newProduct });
    } catch (error) { res.status(500).json({ message: 'Failed to add product.' }); }
});

// --- Invoice Routes ---
app.post('/api/invoices', async (req, res) => {
    try {
        const invoiceData = req.body;
        const newInvoice = {
            ...invoiceData,
            invoiceNumber: `INV-${Date.now()}`,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        const docRef = await db.collection('invoices').add(newInvoice);
        res.status(201).json({ id: docRef.id, ...newInvoice });
    } catch (error) { res.status(500).json({ message: 'Failed to create invoice.' }); }
});

// --- CURRENCY CONVERSION ROUTE ---
app.get('/api/currency/rate', async (req, res) => {
    const { from, to } = req.query;
    const apiKey = process.env.OPEN_EXCHANGE_RATES_API_KEY;

    if (!from || !to) {
        return res.status(400).json({ success: false, message: 'Missing "from" or "to" currency codes.' });
    }
    if (!apiKey) {
        return res.status(500).json({ success: false, message: 'Currency conversion service is not configured.' });
    }
    try {
        const url = `https://open.er-api.com/v6/latest/${from}?apikey=${apiKey}`;
        const response = await fetch(url);
        const data: any = await response.json();
        if (data.result === 'error') throw new Error(data['error-type']);
        const rate = data.rates[to as string];
        if (!rate) return res.status(404).json({ success: false, message: `Conversion rate for "${to}" not found.` });
        res.json({ success: true, rate });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// --- PAYPAL ROUTES ---
const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_API_BASE } = process.env;

const getPayPalAccessToken = async () => {
    const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
    const response = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
        method: 'POST',
        body: 'grant_type=client_credentials',
        headers: { Authorization: `Basic ${auth}` },
    });
    const data: any = await response.json();
    return data.access_token;
};

app.post('/api/paypal/create-order', async (req, res) => {
    try {
        const { totalAmount, currency } = req.body;
        const accessToken = await getPayPalAccessToken();
        const url = `${PAYPAL_API_BASE}/v2/checkout/orders`;
        const payload = {
            intent: 'CAPTURE',
            purchase_units: [{ amount: { currency_code: currency, value: totalAmount } }],
        };
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
            body: JSON.stringify(payload),
        });
        const data: any = await response.json();
        if (!response.ok) throw new Error(data.message);
        res.json({ success: true, orderID: data.id });
    } catch (error: any) {
        console.error('Failed to create order:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/paypal/capture-order', async (req, res) => {
    try {
        const { orderID } = req.body;
        const accessToken = await getPayPalAccessToken();
        const url = `${PAYPAL_API_BASE}/v2/checkout/orders/${orderID}/capture`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        });
        const data: any = await response.json();
        if (!response.ok) throw new Error(data.message);
        res.json({ success: true, data });
    } catch (error: any) {
        console.error('Failed to capture order:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// --- Start Server ---
app.listen(port, () => {
  console.log(`Backend server listening at http://localhost:${port}`);
});

export default app;
