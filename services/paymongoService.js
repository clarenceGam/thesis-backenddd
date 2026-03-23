const axios = require('axios');
const pool = require('../config/database');

class PayMongoService {
  constructor() {
    this.baseUrl = 'https://api.paymongo.com/v1';
    this.secretKey = null;
    this.publicKey = null;
  }

  async loadKeys() {
    if (this.secretKey && this.publicKey) return;
    
    try {
      const [rows] = await pool.query(
        "SELECT setting_key, setting_value FROM platform_settings WHERE setting_key IN ('paymongo_secret_key', 'paymongo_public_key')"
      );
      rows.forEach(row => {
        if (row.setting_key === 'paymongo_secret_key' && row.setting_value) {
          this.secretKey = row.setting_value;
        }
        if (row.setting_key === 'paymongo_public_key' && row.setting_value) {
          this.publicKey = row.setting_value;
        }
      });
    } catch (err) {
      console.error('Failed to load PayMongo keys from database:', err.message);
    }
    
    // Fallback to environment variables if not loaded from database
    if (!this.secretKey) {
      this.secretKey = process.env.PAYMONGO_SECRET_KEY;
    }
    if (!this.publicKey) {
      this.publicKey = process.env.PAYMONGO_PUBLIC_KEY;
    }
    
    if (this.secretKey || this.publicKey) {
      console.log('PayMongo keys loaded:', {
        secretKey: this.secretKey ? 'configured' : 'missing',
        publicKey: this.publicKey ? 'configured' : 'missing',
        source: (this.secretKey === process.env.PAYMONGO_SECRET_KEY) ? 'environment' : 'database'
      });
    }
  }

  getAuthHeader() {
    if (!this.secretKey) throw new Error('PayMongo secret key not configured');
    return {
      Authorization: `Basic ${Buffer.from(this.secretKey).toString('base64')}`,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Create PayMongo Source (for GCash)
   * @param {number} amount - Amount in centavos (PHP 100.00 = 10000)
   * @param {string} type - 'gcash' or 'grab_pay'
   * @param {object} metadata - Additional data
   */
  async createSource(amount, type = 'gcash', metadata = {}) {
    await this.loadKeys();
    
    const payload = {
      data: {
        attributes: {
          amount: Math.round(amount * 100), // Convert to centavos
          currency: 'PHP',
          type,
          redirect: {
            success: metadata.success_url || `${process.env.APP_URL}/payment/success`,
            failed: metadata.failed_url || `${process.env.APP_URL}/payment/failed`,
          },
          billing: metadata.billing || null,
          statement_descriptor: metadata.description || 'Platform Bar Payment',
        },
      },
    };

    try {
      const response = await axios.post(`${this.baseUrl}/sources`, payload, {
        headers: this.getAuthHeader(),
      });
      return response.data.data;
    } catch (err) {
      console.error('PayMongo Create Source Error:', err.response?.data || err.message);
      throw new Error(err.response?.data?.errors?.[0]?.detail || 'Failed to create payment source');
    }
  }

  /**
   * Create Payment Intent (for cards)
   */
  async createPaymentIntent(amount, metadata = {}) {
    await this.loadKeys();
    
    const payload = {
      data: {
        attributes: {
          amount: Math.round(amount * 100),
          currency: 'PHP',
          payment_method_allowed: ['card', 'paymaya'],
          payment_method_options: {
            card: { request_three_d_secure: 'any' },
          },
          description: metadata.description || 'Platform Bar Payment',
          statement_descriptor: 'BAR PLATFORM',
          metadata: metadata.custom_data || {},
        },
      },
    };

    try {
      const response = await axios.post(`${this.baseUrl}/payment_intents`, payload, {
        headers: this.getAuthHeader(),
      });
      return response.data.data;
    } catch (err) {
      console.error('PayMongo Create Payment Intent Error:', err.response?.data || err.message);
      throw new Error(err.response?.data?.errors?.[0]?.detail || 'Failed to create payment intent');
    }
  }

  /**
   * Retrieve Payment by ID
   */
  async getPayment(paymentId) {
    await this.loadKeys();
    
    try {
      const response = await axios.get(`${this.baseUrl}/payments/${paymentId}`, {
        headers: this.getAuthHeader(),
      });
      return response.data.data;
    } catch (err) {
      console.error('PayMongo Get Payment Error:', err.response?.data || err.message);
      return null;
    }
  }

  /**
   * Retrieve Source by ID
   */
  async getSource(sourceId) {
    await this.loadKeys();
    
    try {
      const response = await axios.get(`${this.baseUrl}/sources/${sourceId}`, {
        headers: this.getAuthHeader(),
      });
      return response.data.data;
    } catch (err) {
      console.error('PayMongo Get Source Error:', err.response?.data || err.message);
      return null;
    }
  }

  /**
   * Create Payment from Source (attach source to create payment)
   */
  async attachSourceToPayment(sourceId, metadata = {}) {
    await this.loadKeys();
    const amount = Number(metadata.amount);
    const hasAmount = Number.isFinite(amount) && amount > 0;
    
    const payload = {
      data: {
        attributes: {
          source: { id: sourceId, type: 'source' },
          amount: hasAmount ? Math.round(amount) : undefined,
          currency: 'PHP',
          description: metadata.description || 'Platform Bar Payment',
        },
      },
    };

    try {
      const response = await axios.post(`${this.baseUrl}/payments`, payload, {
        headers: this.getAuthHeader(),
      });
      return response.data.data;
    } catch (err) {
      console.error('PayMongo Attach Source Error:', err.response?.data || err.message);
      throw new Error(err.response?.data?.errors?.[0]?.detail || 'Failed to attach payment source');
    }
  }

  /**
   * Process refund
   */
  async createRefund(paymentId, amount = null, reason = null) {
    await this.loadKeys();
    
    const payload = {
      data: {
        attributes: {
          payment_id: paymentId,
          amount: amount ? Math.round(amount * 100) : undefined,
          reason: reason || 'requested_by_customer',
        },
      },
    };

    try {
      const response = await axios.post(`${this.baseUrl}/refunds`, payload, {
        headers: this.getAuthHeader(),
      });
      return response.data.data;
    } catch (err) {
      console.error('PayMongo Refund Error:', err.response?.data || err.message);
      throw new Error(err.response?.data?.errors?.[0]?.detail || 'Failed to process refund');
    }
  }

  /**
   * Verify webhook signature
   */
  async verifyWebhookSignature(payload, signature) {
    await this.loadKeys();
    
    const [webhookSecretRows] = await pool.query(
      "SELECT setting_value FROM platform_settings WHERE setting_key = 'paymongo_webhook_secret'"
    );
    
    if (!webhookSecretRows.length) {
      console.warn('Webhook secret not configured');
      return false;
    }

    const webhookSecret = webhookSecretRows[0].setting_value;
    const crypto = require('crypto');
    const computedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(JSON.stringify(payload))
      .digest('hex');

    return computedSignature === signature;
  }

  /**
   * Generate payment reference ID
   */
  generateReferenceId(prefix = 'PAY') {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8).toUpperCase();
    return `${prefix}-${timestamp}-${random}`;
  }
}

module.exports = new PayMongoService();
