"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const storage_1 = require("@google-cloud/storage");
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const axios_1 = __importDefault(require("axios"));
const generative_ai_1 = require("@google/generative-ai");
// Load environment variables from .env file
dotenv_1.default.config();
const app = (0, express_1.default)();
const port = process.env.PORT || 3001;
// --- Configuration ---
app.use((0, cors_1.default)());
app.use(express_1.default.json({ limit: '10mb' }));
// Initialize Google Cloud Storage
let storage;
const gcsCredentialsJson = process.env.GOOGLE_CLOUD_CREDENTIALS_JSON; // This is the new env variable we will use
if (gcsCredentialsJson) {
    try {
        // Parse the JSON string from the environment variable
        const credentials = JSON.parse(gcsCredentialsJson);
        storage = new storage_1.Storage({ credentials });
        console.log("Google Cloud Storage initialized with credentials from environment variable.");
    }
    catch (error) {
        console.error("Failed to parse GOOGLE_CLOUD_CREDENTIALS_JSON:", error);
        throw new Error("Invalid Google Cloud credentials JSON in environment variable.");
    }
}
else {
    // Fallback for local development or if GOOGLE_APPLICATION_CREDENTIALS is set externally
    // Ensure that GOOGLE_APPLICATION_CREDENTIALS points to a local file for dev,
    // or ensure your system environment is authenticated (gcloud auth application-default login)
    storage = new storage_1.Storage();
    console.warn("GOOGLE_CLOUD_CREDENTIALS_JSON environment variable not set. Relying on default Google Cloud authentication (e.g., GOOGLE_APPLICATION_CREDENTIALS file or gcloud auth).");
}
const bucketName = process.env.GCS_BUCKET_NAME;
if (!bucketName) {
    throw new Error("GCS_BUCKET_NAME environment variable not set.");
}
const bucket = storage.bucket(bucketName);
// --- PayPal Configuration & Helper Functions ---
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_API_BASE = process.env.PAYPAL_API_BASE;
if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET || !PAYPAL_API_BASE) {
    throw new Error("PayPal environment variables not set.");
}
const generateAccessToken = () => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
        const response = yield axios_1.default.post(`${PAYPAL_API_BASE}/v1/oauth2/token`, 'grant_type=client_credentials', {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': `Basic ${auth}`,
            },
        });
        return response.data.access_token;
    }
    catch (error) {
        console.error("Failed to generate PayPal Access Token:", error.response ? error.response.data : error.message);
        throw new Error("Failed to generate PayPal Access Token.");
    }
});
// --- Open Exchange Rates Configuration & Helper Function ---
const OPEN_EXCHANGE_RATES_API_KEY = process.env.OPEN_EXCHANGE_RATES_API_KEY;
const OPEN_EXCHANGE_RATES_BASE_URL = 'https://open.er-api.com/v6/latest/';
if (!OPEN_EXCHANGE_RATES_API_KEY) {
    throw new Error("OPEN_EXCHANGE_RATES_API_KEY environment variable not set.");
}
const getExchangeRate = (fromCurrency, toCurrency) => __awaiter(void 0, void 0, void 0, function* () {
    if (fromCurrency === toCurrency) {
        return 1;
    }
    try {
        const response = yield axios_1.default.get(`${OPEN_EXCHANGE_RATES_BASE_URL}USD?apikey=${OPEN_EXCHANGE_RATES_API_KEY}`);
        const rates = response.data.rates;
        if (!rates || !rates[fromCurrency] || !rates[toCurrency]) {
            throw new Error(`Rates for ${fromCurrency} or ${toCurrency} not found.`);
        }
        const rateFromUSDToFrom = rates[fromCurrency];
        const rateFromUSDToTo = rates[toCurrency];
        if (fromCurrency === 'USD') {
            return rateFromUSDToTo;
        }
        else if (toCurrency === 'USD') {
            return 1 / rateFromUSDToFrom;
        }
        else {
            return (1 / rateFromUSDToFrom) * rateFromUSDToTo;
        }
    }
    catch (error) {
        console.error(`Failed to get exchange rate for ${fromCurrency} to ${toCurrency}:`, error.response ? error.response.data : error.message);
        throw new Error(`Failed to get exchange rate: ${error.message}`);
    }
});
// Helper function to create a PayPal order
const createOrder = (cartItems_1, originalCurrency_1, ...args_1) => __awaiter(void 0, [cartItems_1, originalCurrency_1, ...args_1], void 0, function* (cartItems, originalCurrency, intent = 'CAPTURE') {
    let targetCurrency = originalCurrency;
    let convertedCartItems = cartItems;
    if (originalCurrency === 'ZAR' && (PAYPAL_API_BASE === null || PAYPAL_API_BASE === void 0 ? void 0 : PAYPAL_API_BASE.includes('sandbox'))) {
        console.log("Attempting to convert ZAR to USD for PayPal Sandbox compatibility...");
        targetCurrency = 'USD';
        convertedCartItems = yield Promise.all(cartItems.map((item) => __awaiter(void 0, void 0, void 0, function* () {
            const rate = yield getExchangeRate('ZAR', 'USD');
            const convertedPrice = (parseFloat(item.price) * rate).toFixed(2);
            console.log(`Converted R${item.price} to $${convertedPrice} using rate ${rate}`);
            return Object.assign(Object.assign({}, item), { price: convertedPrice });
        })));
    }
    else if (originalCurrency !== 'USD') {
        console.log(`Converting ${originalCurrency} to USD for PayPal processing...`);
        targetCurrency = 'USD';
        convertedCartItems = yield Promise.all(cartItems.map((item) => __awaiter(void 0, void 0, void 0, function* () {
            const rate = yield getExchangeRate(originalCurrency, 'USD');
            const convertedPrice = (parseFloat(item.price) * rate).toFixed(2);
            console.log(`Converted ${originalCurrency}${item.price} to $${convertedPrice} using rate ${rate}`);
            return Object.assign(Object.assign({}, item), { price: convertedPrice });
        })));
    }
    const accessToken = yield generateAccessToken();
    const purchaseUnits = convertedCartItems.map((item, index) => ({
        // NEW: Add a unique reference_id for each purchase unit
        reference_id: `item-${item.name.replace(/\s/g, '_')}-${index}-${Date.now()}`,
        amount: {
            currency_code: targetCurrency,
            value: item.price,
        },
        description: item.name,
    }));
    try {
        const response = yield axios_1.default.post(`${PAYPAL_API_BASE}/v2/checkout/orders`, {
            intent: intent,
            purchase_units: purchaseUnits,
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`,
            },
        });
        return response.data;
    }
    catch (error) {
        console.error("Failed to create PayPal order:", error.response ? error.response.data : error.message);
        throw new Error("Failed to create PayPal order.");
    }
});
const captureOrder = (orderId) => __awaiter(void 0, void 0, void 0, function* () {
    const accessToken = yield generateAccessToken();
    try {
        const response = yield axios_1.default.post(`${PAYPAL_API_BASE}/v2/checkout/orders/${orderId}/capture`, {}, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`,
            },
        });
        return response.data;
    }
    catch (error) {
        console.error("Failed to capture PayPal order:", error.response ? error.response.data : error.message);
        throw new Error("Failed to capture PayPal order.");
    }
});
// --- Gemini Configuration & Proxy Endpoint ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
let genAI = null;
if (GEMINI_API_KEY) {
    genAI = new generative_ai_1.GoogleGenerativeAI(GEMINI_API_KEY);
    console.log("Gemini AI client initialized for backend proxy.");
}
else {
    console.warn("GEMINI_API_KEY for backend is not set in environment variables. Gemini proxy will not function.");
}
app.post('/api/gemini/generate-email', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { prompt } = req.body;
    console.log(`[POST] Request for Gemini email generation with prompt: "${prompt.substring(0, 50)}..."`);
    if (!genAI) {
        const msg = "Gemini AI client not initialized on backend (API_KEY missing). Cannot generate email.";
        console.error(msg);
        return res.status(503).json({ success: false, message: msg });
    }
    if (!prompt) {
        return res.status(400).json({ success: false, message: 'Prompt is required for email generation.' });
    }
    try {
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-preview-04-17' });
        const result = yield model.generateContent(prompt);
        const responseText = result.response.text();
        console.log("Gemini email generation successful.");
        res.status(200).json({ success: true, emailContent: responseText });
    }
    catch (error) {
        console.error('Error proxying Gemini request:', error.response ? error.response.data : error.message);
        res.status(500).json({ success: false, message: `Failed to generate email content via Gemini proxy: ${error.message}` });
    }
}));
// --- API Routes (Existing GCS routes) ---
app.get('/api/data/:fileName', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { fileName } = req.params;
    console.log(`[GET] Request for file: ${fileName}.json`);
    try {
        const file = bucket.file(`${fileName}.json`);
        const [data] = yield file.download();
        const jsonString = data.toString('utf8');
        res.setHeader('Content-Type', 'application/json');
        res.status(200).send(jsonString);
    }
    catch (error) {
        if (error.code === 404) {
            console.log(`File ${fileName}.json not found. Returning empty array.`);
            res.status(200).json([]);
        }
        else {
            console.error(`Error fetching ${fileName}.json:`, error);
            res.status(500).json({ success: false, message: `Failed to fetch data: ${error.message}` });
        }
    }
}));
app.post('/api/data/:fileName', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { fileName } = req.params;
    const content = req.body;
    console.log(`[POST] Request to save file: ${fileName}.json`);
    if (!content) {
        return res.status(400).json({ success: false, message: 'No content provided to save.' });
    }
    try {
        const file = bucket.file(`${fileName}.json`);
        yield file.save(JSON.stringify(content, null, 2), {
            contentType: 'application/json',
        });
        console.log(`Successfully saved ${fileName}.json to bucket ${bucketName}.`);
        res.status(200).json({ success: true, message: 'Data saved successfully.' });
    }
    catch (error) {
        console.error(`Error saving ${fileName}.json:`, error);
        res.status(500).json({ success: false, message: `Failed to save data: ${error.message}` });
    }
}));
// --- PayPal API Routes ---
app.post('/api/paypal/create-order', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const { cartItems, currency = 'USD' } = req.body;
        if (!cartItems || !Array.isArray(cartItems) || cartItems.length === 0) {
            return res.status(400).json({ success: false, message: 'No content provided to create an order.' });
        }
        const order = yield createOrder(cartItems, currency);
        res.status(200).json({ success: true, orderID: order.id });
    }
    catch (error) {
        console.error("Error creating PayPal order:", error.message);
        res.status(500).json({ success: false, message: `Failed to create PayPal order: ${error.message}` });
    }
}));
app.post('/api/paypal/capture-order', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const { orderID } = req.body;
        if (!orderID) {
            return res.status(400).json({ success: false, message: 'Order ID is required to capture the order.' });
        }
        const captureResult = yield captureOrder(orderID);
        res.status(200).json({ success: true, captureResult });
    }
    catch (error) {
        console.error("Error capturing PayPal order:", error.response ? error.response.data : error.message);
        res.status(500).json({ success: false, message: `Failed to capture PayPal data: ${error.message}` });
    }
}));
// Start the server
app.listen(port, () => {
    console.log(`CUTH-TECH backend server listening at http://localhost:${port}`);
});
