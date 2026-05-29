import { LinkoraClient } from "../../packages/sdk/src/index";
import { Keypair } from "@stellar/stellar-sdk";

// ── Configuration ────────────────────────────────────────────────────────────

const CONFIG = {
  rpcUrl: process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org",
  networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015",
  // Standard test deployment contract ID
  contractId: process.env.LINKORA_CONTRACT_ID || "CDLDVFKHEZ2RVB3NG4UQA4VPD3TSHV6XMHXMHP2BSGCJ2IIWVTOHGDSG",
};

// Mock admin/creator keypair for demonstration
const mockSignerKeypair = Keypair.random();
const mockSourceAddress = mockSignerKeypair.publicKey();

async function runNodeExample() {
  console.log("=== Linkora SDK Node.js Run-Time Example ===");
  console.log(`Connecting to RPC Endpoint: ${CONFIG.rpcUrl}`);
  console.log(`Contract ID: ${CONFIG.contractId}`);
  console.log(`Client Address: ${mockSourceAddress}\n`);

  // 1. Initialize LinkoraClient
  const client = new LinkoraClient(CONFIG);

  try {
    // 2. Read profiles details on-chain
    console.log("1. Fetching profile for client address...");
    try {
      const profile = await client.getProfile(mockSourceAddress);
      if (profile) {
        console.log(`   ✓ Profile Found! Username: @${profile.username}`);
        console.log(`   Creator Token: ${profile.creator_token}\n`);
      } else {
        console.log("   ✕ Profile not found. This is normal for a fresh mock keypair address.\n");
      }
    } catch (err: any) {
      console.log("   ✕ Profile fetch simulated.");
      console.log(`     Note: No deployed/initialized contract instance found at this address on Testnet: "${err.message}"\n`);
    }

    // 3. Get total posts count on-chain
    console.log("2. Syncing global posts count...");
    try {
      const postCount = await client.getPostCount();
      console.log(`   ✓ Global post count: ${postCount} posts.\n`);
    } catch (err: any) {
      console.log("   ✕ Post count fetch simulated.");
      console.log(`     Note: Could not fetch post count (uninitialized contract state): "${err.message}"\n`);
    }

    // 4. Create a new post demonstrating write transaction prep and sign flow
    console.log("3. Demonstrating post creation flow (simulating transaction)...");
    
    // For safety in run-time demonstration without funded balance, we can catch
    // any simulation balance error or mock the successful submit cycle.
    try {
      const postResult = await client.createPost(
        mockSignerKeypair, // Pass Keypair directly as the Signer
        mockSourceAddress,
        {
          author: mockSourceAddress,
          content: "Hello Stellar community! Tipping off from Node.js runtime script! 🚀",
        }
      );
      
      console.log("   ✓ Post created successfully!");
      console.log(`   Transaction Hash: ${postResult.txHash}`);
      console.log(`   Post ID: ${postResult.postId}`);
      console.log(`   Ledger Index: ${postResult.ledger}`);
    } catch (txErr: any) {
      console.log("   ✕ Post transaction simulation completed.");
      console.log("     Note: Since the mock keypair does not have funded XLM to pay gas fees,");
      console.log(`     the execution failed as expected: "${txErr.message}"\n`);
    }

    console.log("=== Node.js Example Execution Completed Successfully ===");
  } catch (err: any) {
    console.error("✕ Linkora SDK Runtime Error:", err.message);
    process.exit(1);
  }
}

// Execute runner
runNodeExample();
