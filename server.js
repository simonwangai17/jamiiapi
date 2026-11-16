// server.js — M-Pesa STK Push Backend
const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;
const BASE = process.env.NODE_ENV === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

console.log('Running in', process.env.NODE_ENV || 'sandbox', 'mode');

const transactions = {};
let tokenCache = { token: null, expiresAt: 0 };

async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }
  const auth = Buffer.from(
    process.env.MPESA_CONSUMER_KEY + ':' + process.env.MPESA_CONSUMER_SECRET
  ).toString('base64');
  const res = await axios.get(
    BASE + '/oauth/v1/generate?grant_type=client_credentials',
    { headers: { Authorization: 'Basic ' + auth } }
  );
  tokenCache = {
    token: res.data.access_token,
    expiresAt: Date.now() + (parseInt(res.data.expires_in, 10) - 60) * 1000,
  };
  return tokenCache.token;
}

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    mode: process.env.NODE_ENV,
    shortcode: process.env.MPESA_SHORTCODE,
    till: process.env.MPESA_PARTY_B,
    callback: process.env.MPESA_CALLBACK_URL,
  });
});

app.post('/stkpush', async (req, res) => {
  try {
    const { phone, amount } = req.body;

    let cleanPhone = String(phone || '').replace(/\D/g, '');
    if (cleanPhone.startsWith('0')) cleanPhone = '254' + cleanPhone.slice(1);
    if (cleanPhone.startsWith('7') || cleanPhone.startsWith('1')) cleanPhone = '254' + cleanPhone;

    if (!/^254(7|1)\d{8}$/.test(cleanPhone)) {
      return res.status(400).json({ success: false, error: 'Invalid phone' });
    }

    const numAmount = parseFloat(amount);
    if (!numAmount || numAmount < 1 || numAmount > 250000) {
      return res.status(400).json({ success: false, error: 'Amount must be 1-250000' });
    }

    const token = await getToken();

    const timestamp = new Date().toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
    const password = Buffer.from(
      process.env.MPESA_SHORTCODE + process.env.MPESA_PASSKEY + timestamp
    ).toString('base64');

    const payload = {
      BusinessShortCode: process.env.MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: process.env.MPESA_TXN_TYPE || 'CustomerBuyGoodsOnline',
      Amount: Math.round(numAmount),
      PartyA: cleanPhone,
      PartyB: process.env.MPESA_PARTY_B,
      PhoneNumber: cleanPhone,
      CallBackURL: process.env.MPESA_CALLBACK_URL,
      AccountReference: 'JAMIISIM',
      TransactionDesc: 'Payment',
    };

    console.log('Sending STK:', JSON.stringify(payload, null, 2));

    const stkRes = await axios.post(
      BASE + '/mpesa/stkpush/v1/processrequest',
      payload,
      { headers: { Authorization: 'Bearer ' + token } }
    );

    console.log('STK Response:', JSON.stringify(stkRes.data, null, 2));

    transactions[stkRes.data.CheckoutRequestID] = {
      status: 'pending',
      phone: cleanPhone,
      amount: numAmount,
    };

    res.json({
      success: true,
      checkoutRequestId: stkRes.data.CheckoutRequestID,
    });
  } catch (err) {
    console.error('STK error:', err.response?.data || err.message);
    res.status(500).json({
      success: false,
      error: err.response?.data?.errorMessage || err.message,
    });
  }
});

app.post('/callback', (req, res) => {
  try {
    const stk = req.body.Body?.stkCallback;
    if (!stk) return res.status(400).json({ ResultCode: 1, ResultDesc: 'Invalid' });

    console.log('Callback:', JSON.stringify(stk, null, 2));

    const id = stk.CheckoutRequestID;

    if (stk.ResultCode === 0) {
      const receipt = stk.CallbackMetadata?.Item?.find(i => i.Name === 'MpesaReceiptNumber')?.Value || 'N/A';
      transactions[id] = {
        ...transactions[id],
        status: 'success',
        receipt,
      };
      console.log('SUCCESS:', receipt);
    } else {
      transactions[id] = {
        ...transactions[id],
        status: 'failed',
        reason: stk.ResultDesc,
      };
      console.log('FAILED:', stk.ResultDesc);
    }

    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  } catch (err) {
    console.error('Callback error:', err);
    res.status(500).json({ ResultCode: 1, ResultDesc: 'Error' });
  }
});

app.get('/status/:id', (req, res) => {
  const tx = transactions[req.params.id];
  if (!tx) {
    return res.json({ status: 'pending', resultCode: '0' }); 
  }
  if (tx.status === 'success') {
    return res.json({
      status: 'success',
      resultCode: '0',
      receipt: tx.receipt,
    });
  }
  if (tx.status === 'failed') {
    return res.json({
      status: 'failed',
      resultCode: '1032',
      reason: tx.reason,
    });
  }
  return res.json({ status: 'pending' });
});

app.listen(PORT, () => console.log('Server running on port', PORT));
