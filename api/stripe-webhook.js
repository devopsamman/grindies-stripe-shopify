export const config = {
  api: {
    bodyParser: false
  }
};

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";

    req.on("data", (chunk) => {
      data += chunk.toString();
    });

    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function verifyStripeSignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;

  const parts = signature.split(",");
  const timestampPart = parts.find((part) => part.startsWith("t="));
  const signatureParts = parts
    .filter((part) => part.startsWith("v1="))
    .map((part) => part.slice(3));

  if (!timestampPart || signatureParts.length === 0) return false;

  const timestamp = timestampPart.slice(2);
  const timestampNumber = Number(timestamp);

  // Reject old/replayed webhook requests (5 minutes).
  if (!Number.isFinite(timestampNumber)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - timestampNumber) > 300) {
    return false;
  }

  const signedPayload = `${timestamp}.${rawBody}`;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(signedPayload)
  );

  const expected = toHex(digest);

  return signatureParts.some((candidate) =>
    timingSafeEqual(candidate, expected)
  );
}

function splitName(fullName) {
  const name = (fullName || "Stripe Customer").trim();
  const pieces = name.split(/\s+/);

  return {
    firstName: pieces.shift() || "Stripe",
    lastName: pieces.join(" ") || "Customer"
  };
}

function normalizeAddress(address, fallbackName, fallbackPhone) {
  if (!address) return undefined;

  const name = splitName(fallbackName);

  return {
    firstName: name.firstName,
    lastName: name.lastName,
    address1: address.line1 || "",
    address2: address.line2 || undefined,
    city: address.city || "",
    province: address.state || undefined,
    country: address.country || "",
    zip: address.postal_code || "",
    phone: address.phone || fallbackPhone || undefined
  };
}

async function getStripeLineItems(sessionId, secret) {
  const response = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}/line_items?limit=100`,
    {
      headers: {
        Authorization: `Bearer ${secret}`
      }
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Stripe line item lookup failed: ${data?.error?.message || "Unknown error"}`
    );
  }

  return data.data || [];
}

async function getShopifyAccessToken(shop, clientId, clientSecret) {
  const response = await fetch(
    `https://${shop}.myshopify.com/admin/oauth/access_token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret
      })
    }
  );

  const data = await response.json();

  if (!response.ok || !data.access_token) {
    throw new Error(
      `Shopify authentication failed: ${JSON.stringify(data)}`
    );
  }

  return data.access_token;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }

  try {
    const stripeSecret = process.env.STRIPE_SECRET_KEY;
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    const shop = process.env.SHOPIFY_SHOP;
    const clientId = process.env.SHOPIFY_CLIENT_ID;
    const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

    if (
      !stripeSecret ||
      !webhookSecret ||
      !shop ||
      !clientId ||
      !clientSecret
    ) {
      return res.status(500).json({
        success: false,
        error: "Missing required environment variables"
      });
    }

    const rawBody = await readRawBody(req);
    const signature = req.headers["stripe-signature"];

    const validSignature = await verifyStripeSignature(
      rawBody,
      signature,
      webhookSecret
    );

    if (!validSignature) {
      return res.status(400).json({
        success: false,
        error: "Invalid Stripe webhook signature"
      });
    }

    const event = JSON.parse(rawBody);

    // We only create Shopify orders for successfully completed Checkout sessions.
    if (event.type !== "checkout.session.completed") {
      return res.status(200).json({
        received: true,
        ignored: true,
        eventType: event.type
      });
    }

    const session = event.data?.object;

    if (!session?.id) {
      return res.status(400).json({
        success: false,
        error: "Stripe Checkout session is missing"
      });
    }

    // Prevent accidental creation from an unpaid/incomplete session.
    if (session.payment_status !== "paid") {
      return res.status(200).json({
        received: true,
        ignored: true,
        reason: "Stripe payment is not marked paid",
        paymentStatus: session.payment_status
      });
    }

    const amount = Number(session.amount_total || 0) / 100;
    const currency = String(session.currency || "usd").toUpperCase();

    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        error: "Stripe session has no positive total amount"
      });
    }

    const customerDetails = session.customer_details || {};
    const customerName = customerDetails.name || "Stripe Customer";
    const customerEmail =
      customerDetails.email ||
      session.customer_email ||
      "stripe-customer@example.com";
    const customerPhone = customerDetails.phone || undefined;

    const name = splitName(customerName);

    const shipping = session.shipping_details?.address
      ? normalizeAddress(
          session.shipping_details.address,
          session.shipping_details.name || customerName,
          customerPhone
        )
      : undefined;

    const billing = customerDetails.address
      ? normalizeAddress(customerDetails.address, customerName, customerPhone)
      : undefined;

    // Get the actual Stripe Checkout line items.
    const stripeItems = await getStripeLineItems(session.id, stripeSecret);

    if (stripeItems.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Stripe Checkout session has no line items"
      });
    }

    // Current Grindies Shopify product variant used by the test Payment Link.
    // Replace this only if the Payment Link should map to another Grindies variant.
    const grindiesVariantId =
      "gid://shopify/ProductVariant/45179315519558";

    const lineItems = stripeItems.map((item) => ({
      variantId: grindiesVariantId,
      quantity: Number(item.quantity || 1)
    }));

    const accessToken = await getShopifyAccessToken(
      shop,
      clientId,
      clientSecret
    );

    const mutation = `
      mutation orderCreate($order: OrderCreateOrderInput!) {
        orderCreate(order: $order) {
          userErrors {
            field
            message
          }
          order {
            id
            name
            displayFinancialStatus
            displayFulfillmentStatus
            email
            phone
            totalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            subtotalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            transactions {
              id
              kind
              status
              test
              gateway
              amountSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
            }
            lineItems(first: 100) {
              nodes {
                title
                quantity
                variant {
                  id
                }
              }
            }
          }
        }
      }
    `;

    const order = {
      lineItems,
      email: customerEmail,
      phone: customerPhone,
      note:
        `STRIPE TEST ORDER - Payment Link - NO REAL PAYMENT. Stripe Checkout Session: ${session.id}`,
      customer: {
        toUpsert: {
          email: customerEmail,
          firstName: name.firstName,
          lastName: name.lastName,
          phone: customerPhone
        }
      },
      financialStatus: "PAID",
      transactions: [
        {
          kind: "SALE",
          status: "SUCCESS",
          gateway: "Stripe",
          test: true,
          amountSet: {
            shopMoney: {
              amount: amount.toFixed(2),
              currencyCode: currency
            }
          }
        }
      ]
    };

    if (shipping) {
      order.shippingAddress = shipping;
    }

    if (billing) {
      order.billingAddress = billing;
    }

    const shopifyResponse = await fetch(
      `https://${shop}.myshopify.com/admin/api/2026-07/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken
        },
        body: JSON.stringify({
          query: mutation,
          variables: { order }
        })
      }
    );

    const shopifyData = await shopifyResponse.json();

    if (!shopifyResponse.ok || shopifyData.errors) {
      console.error("Shopify GraphQL error:", shopifyData);
      return res.status(500).json({
        success: false,
        error: "Shopify order creation request failed",
        details: shopifyData
      });
    }

    const result = shopifyData.data?.orderCreate;

    if (result?.userErrors?.length) {
      console.error("Shopify orderCreate user errors:", result.userErrors);
      return res.status(400).json({
        success: false,
        error: "Shopify rejected the order",
        details: result.userErrors
      });
    }

    return res.status(200).json({
      success: true,
      message: "Stripe TEST payment received and Shopify order created",
      stripe: {
        eventId: event.id,
        sessionId: session.id,
        amount,
        currency,
        customerName,
        customerEmail,
        shippingAddressCollected: Boolean(shipping),
        billingAddressCollected: Boolean(billing)
      },
      shopify: result.order
    });
  } catch (error) {
    console.error("Stripe webhook error:", error);

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}
