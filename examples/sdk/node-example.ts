import { KovaraClient, KovaraError, NotFoundError, InsufficientBalanceError, validateManifest, InvalidManifestError } from "../../packages/sdk/src/index";
import { Keypair } from "@stellar/stellar-sdk";
import { readFileSync } from "fs";
import { join } from "path";

// ── Configuration ────────────────────────────────────────────────────────────

const CONFIG = {
  rpcUrl: process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org",
  networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015",
  // Standard test deployment contract ID
  contractId:
    process.env.Kovara_CONTRACT_ID || "CDLDVFKHEZ2RVB3NG4UQA4VPD3TSHV6XMHXMHP2BSGCJ2IIWVTOHGDSG",
};

// Mock admin/creator keypair for demonstration
const mockSignerKeypair = Keypair.random();
const mockSourceAddress = mockSignerKeypair.publicKey();

async function runNodeExample() {
  console.log("=== Kovara SDK Node.js Run-Time Example ===");
  console.log(`Connecting to RPC Endpoint: ${CONFIG.rpcUrl}`);
  console.log(`Contract ID: ${CONFIG.contractId}`);
  console.log(`Client Address: ${mockSourceAddress}\n`);

  // 1. Initialize KovaraClient
  const client = new KovaraClient(CONFIG);

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
    } catch (err) {
      console.log("   ✕ Profile fetch simulated.");
      // Expected error: NotFoundError when profile doesn't exist or contract not initialized
      const error = err instanceof KovaraError ? err : new KovaraError(String(err));
      console.log(
        `     Note: No deployed/initialized contract instance found at this address on Testnet: "${error.message}"\n`
      );
    }

    // 3. Get total posts count on-chain
    console.log("2. Syncing global posts count...");
    try {
      const postCount = await client.getPostCount();
      console.log(`   ✓ Global post count: ${postCount} posts.\n`);
    } catch (err) {
      console.log("   ✕ Post count fetch simulated.");
      // Expected error: NotFoundError or KovaraError when contract not initialized
      const error = err instanceof KovaraError ? err : new KovaraError(String(err));
      console.log(
        `     Note: Could not fetch post count (uninitialized contract state): "${error.message}"\n`
      );
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
    } catch (txErr) {
      console.log("   ✕ Post transaction simulation completed.");
      // Expected error: InsufficientBalanceError when mock keypair lacks XLM for gas fees
      const error = txErr instanceof KovaraError ? txErr : new KovaraError(String(txErr));
      console.log("     Note: Since the mock keypair does not have funded XLM to pay gas fees,");
      console.log(`     the execution failed as expected: "${error.message}"\n`);
    }

    console.log("=== Node.js Example Execution Completed Successfully ===");
  } catch (err) {
    // Catch-all for unexpected SDK errors
    const error = err instanceof KovaraError ? err : new KovaraError(String(err));
    console.error("✕ Kovara SDK Runtime Error:", error.message);
    process.exit(1);
  }
}

// ── Mini-App Manifest Validation Example ───────────────────────────────────────

async function demonstrateManifestValidation() {
  console.log("\n=== Mini-App Manifest Validation Example ===");

  // Example 1: Valid tip-jar manifest (SDK-compliant)
  console.log("\n1. Validating a compliant tip-jar manifest...");
  const validManifest = {
    name: "Tip Jar",
    version: "1.0.0",
    description: "Tip any Kovara post with XLM using your connected wallet.",
    entryPoint: "https://example.com/tip-jar/index.html",
    icon: "https://example.com/tip-jar/icon.svg",
    permissions: ["wallet.read", "wallet.sign"],
    author: "Kovara Contributors",
    homepage: "https://github.com/Epta-Node/Kovara",
  };

  try {
    const validated = validateManifest(validManifest);
    console.log("   ✓ Manifest validated successfully!");
    console.log(`   Name: ${validated.name}`);
    console.log(`   Version: ${validated.version}`);
    console.log(`   Permissions: ${validated.permissions.join(", ")}\n`);
  } catch (err) {
    const error = err instanceof InvalidManifestError ? err : new InvalidManifestError(String(err));
    console.error(`   ✕ Validation failed: ${error.message}\n`);
  }

  // Example 2: Invalid manifest (HTTP instead of HTTPS)
  console.log("2. Validating manifest with HTTP entryPoint (should fail)...");
  const invalidManifest = {
    name: "Tip Jar",
    version: "1.0.0",
    entryPoint: "http://example.com/tip-jar/index.html", // HTTP not allowed
    permissions: ["wallet.read"],
  };

  try {
    validateManifest(invalidManifest);
    console.log("   ✕ Manifest should have failed validation but passed!\n");
  } catch (err) {
    const error = err instanceof InvalidManifestError ? err : new InvalidManifestError(String(err));
    console.log("   ✓ Validation correctly rejected insecure manifest:");
    console.log(`     Error: ${error.message}\n`);
  }

  // Example 3: Invalid manifest (unknown permission)
  console.log("3. Validating manifest with unknown permission (should fail)...");
  const invalidPermissionManifest = {
    name: "Tip Jar",
    version: "1.0.0",
    entryPoint: "https://example.com/tip-jar/index.html",
    permissions: ["wallet.read", "unknown.permission"], // Invalid permission
  };

  try {
    validateManifest(invalidPermissionManifest);
    console.log("   ✕ Manifest should have failed validation but passed!\n");
  } catch (err) {
    const error = err instanceof InvalidManifestError ? err : new InvalidManifestError(String(err));
    console.log("   ✓ Validation correctly rejected unknown permission:");
    console.log(`     Error: ${error.message}\n`);
  }

  // Example 4: Load and validate from JSON file (if file exists)
  console.log("4. Loading and validating manifest from file...");
  try {
    const manifestPath = join(process.cwd(), "examples/mini-apps/tip-jar/linkora-manifest.json");
    const manifestContent = readFileSync(manifestPath, "utf-8");
    const parsedManifest = JSON.parse(manifestContent);

    // Note: The tip-jar manifest uses different field names than SDK expects
    // This demonstrates safe validation with error handling
    try {
      validateManifest(parsedManifest);
      console.log("   ✓ File manifest validated successfully!\n");
    } catch (err) {
      const error = err instanceof InvalidManifestError ? err : new InvalidManifestError(String(err));
      console.log("   ℹ File manifest uses legacy format (expected for demo):");
      console.log(`     Error: ${error.message}`);
      console.log("     Tip: Update manifest to use SDK-compliant field names:\n");
      console.log("       - 'entry' → 'entryPoint'");
      console.log("       - 'wallet.getAddress' → 'wallet.read'");
      console.log("       - 'wallet.signTransaction' → 'wallet.sign'\n");
    }
  } catch (fileErr) {
    console.log("   ℹ Could not load manifest file (file may not exist in this environment)\n");
  }

  console.log("=== Manifest Validation Example Completed ===");
}

// Execute both examples
async function runAllExamples() {
  await runNodeExample();
  await demonstrateManifestValidation();
}

runAllExamples();
