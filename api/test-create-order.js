export default async function handler(req, res) {
  try {
    // Safety switch: the URL must explicitly contain ?run=true
    if (req.query.run !== "true") {
      return res.status(400).json({
        success: false,
        message: "Test order not created. Add ?run=true to the URL."
      });
    }

    const shop = process.env.SHOPIFY_SHOP;
    const clientId = process.env.SHOPIFY_CLIENT_ID;
    const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

    if (!shop || !clientId || !clientSecret) {
      return res.status(500).json({
        success: false,
        error: "Missing Shopify environment variables"
      });
    }

    // Your existing Grindies product variant
    const variantId =
      "gid://shopify/ProductVariant/45179315519558";

    // Get Shopify Admin API access token
    const tokenResponse = await fetch(
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

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok || !tokenData.access_token) {
      return res.status(401).json({
        success: false,
        error: "Shopify authentication failed",
        details: tokenData
      });
    }

    // Create ONE clearly marked TEST order
    const mutation = `
      mutation orderCreate(
        $order: OrderCreateOrderInput!
      ) {
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
            totalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            lineItems(first: 10) {
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

    const variables = {
      order: {
        lineItems: [
          {
            variantId: variantId,
            quantity: 1
          }
        ],
        email: "grindies-test@example.com",
        note: "TEST ORDER - Stripe integration test - NO REAL PAYMENT",
        customer: {
          toUpsert: {
            email: "grindies-test@example.com",
            firstName: "Stripe",
            lastName: "Test"
          }
        },
        financialStatus: "PAID"
      }
    };

    const shopifyResponse = await fetch(
      `https://${shop}.myshopify.com/admin/api/2026-07/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": tokenData.access_token
        },
        body: JSON.stringify({
          query: mutation,
          variables
        })
      }
    );

    const shopifyData = await shopifyResponse.json();

    if (!shopifyResponse.ok || shopifyData.errors) {
      return res.status(500).json({
        success: false,
        error: "Shopify order creation request failed",
        details: shopifyData
      });
    }

    const result = shopifyData.data?.orderCreate;

    if (result?.userErrors?.length > 0) {
      return res.status(400).json({
        success: false,
        error: "Shopify rejected the order",
        details: result.userErrors
      });
    }

    return res.status(200).json({
      success: true,
      message: "TEST order created successfully!",
      warning: "This is a fake Shopify order. No real payment was made.",
      order: result.order
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}
