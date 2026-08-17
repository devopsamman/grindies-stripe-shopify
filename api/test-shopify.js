export default async function handler(req, res) {
  try {
    const shop = process.env.SHOPIFY_SHOP;
    const clientId = process.env.SHOPIFY_CLIENT_ID;
    const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

    if (!shop || !clientId || !clientSecret) {
      return res.status(500).json({
        success: false,
        error: "Missing Shopify environment variables"
      });
    }

    // Get a Shopify Admin API access token
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

    // Read existing Grindies products
    const query = `
      query {
        products(first: 20) {
          nodes {
            id
            title
            status
            variants(first: 20) {
              nodes {
                id
                title
                price
                sku
              }
            }
          }
        }
      }
    `;

    const shopifyResponse = await fetch(
      `https://${shop}.myshopify.com/admin/api/2026-07/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": tokenData.access_token
        },
        body: JSON.stringify({ query })
      }
    );

    const shopifyData = await shopifyResponse.json();

    if (!shopifyResponse.ok || shopifyData.errors) {
      return res.status(500).json({
        success: false,
        error: "Shopify GraphQL request failed",
        details: shopifyData
      });
    }

    return res.status(200).json({
      success: true,
      message: "Grindies Shopify connection is working!",
      shop: `${shop}.myshopify.com`,
      products: shopifyData.data.products.nodes
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}
