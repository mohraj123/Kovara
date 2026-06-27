# Stellar Sandbox & Testnet Setup Guide

This document covers how to set up a local Stellar sandbox for contract development, run integration tests, and deploy contracts to the Stellar testnet.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Local Sandbox Development](#local-sandbox-development)
- [Running Contract Tests](#running-contract-tests)
  - [Unit Tests (Soroban Sandbox)](#unit-tests-soroban-sandbox)
  - [Integration Tests (Full Sandbox)](#integration-tests-full-sandbox)
- [Testnet Deployment](#testnet-deployment)
- [Connecting to Testnet from Apps](#connecting-to-testnet-from-apps)
- [Troubleshooting](#troubleshooting)

## Prerequisites

First, install all required dependencies:

### 1. Install Rust & Soroban/Stellar CLI

```bash
# Install Rust (if not already installed)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Install Soroban CLI for contract development
cargo install --locked soroban-cli

# Install Stellar CLI v22.8.1 (required for sandbox integration tests)
cargo install --locked stellar-cli --version 22.8.1

# Add WebAssembly target
rustup target add wasm32-unknown-unknown
```

### 2. Install Docker

Docker is required to run the full Stellar sandbox container for integration tests. Download and install Docker Desktop from [docker.com](https://www.docker.com/products/docker-desktop/).

### 3. Install Node.js Dependencies

```bash
# From repository root
pnpm install
```

## Local Sandbox Development

The local Stellar sandbox allows you to develop and test contracts against a local, ephemeral Stellar network before deploying to testnet or mainnet.

### Starting the Sandbox Manually

If you want to run the sandbox outside of the integration test script:

```bash
# Start the Stellar sandbox container
stellar sandbox start

# Verify it's running
stellar sandbox status
```

### Manual Contract Deployment to Sandbox

```bash
# Navigate to contracts directory
cd packages/contracts

# Build the contracts
cargo build --target wasm32-unknown-unknown --release

# Deploy to local sandbox
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/kovara_contracts.wasm \
  --source <your-sandbox-secret-key> \
  --rpc-url http://localhost:8000/rpc \
  --network-passphrase "Standalone Network ; February 2014"
```

### Stopping the Sandbox

```bash
stellar sandbox stop
```

## Running Contract Tests

Kovara has two types of contract tests: unit tests that run on the embedded Soroban sandbox, and full integration tests that run against a local sandbox container.

### Unit Tests (Soroban Sandbox)

These fast-running unit tests use Soroban's built-in testing environment and don't require Docker or a running sandbox.

```bash
# From repository root
pnpm --filter @kovara/contracts test

# Or directly from contracts directory
cd packages/contracts
cargo test
```

Unit tests are located in each contract's test file:

- `packages/contracts/tests/price_vault_test.rs`
- `packages/contracts/tests/sentinel_pool_test.rs`
- `packages/contracts/tests/flow_rewards_test.rs`
- `packages/contracts/tests/kovara_index_test.rs`

### Integration Tests (Full Sandbox)

These end-to-end tests run against a real local sandbox container, using actual transaction signing and cross-contract interactions. They validate real-world contract behavior.

#### Prerequisites

- Docker is running
- Stellar CLI v22.8.1 is installed

#### Run Integration Tests

```bash
# From repository root
pnpm test:integration

# Or directly run the script
./tests/integration/run_e2e.sh
```

The integration test script automatically:

1. Starts a local sandbox container
2. Generates and funds test identities
3. Builds and deploys the Kovara contracts
4. Deploys a test token contract for asset interactions
5. Executes signed transactions for all core flows:
   - Profile creation
   - Follow/unfollow relationships
   - Post creation and deletion
   - Liking posts
   - Tipping posts with tokens
   - Pool creation, deposits, and withdrawals
6. Asserts all contract state changes are correct
7. Stops the sandbox and cleans up temporary files

## Testnet Deployment

Deploying contracts to the Stellar testnet allows you to test them against the public Stellar network, with real testnet XLM from the friendbot.

### 1. Get a Testnet Account

1. Create a new Stellar account key pair:
   ```bash
   stellar keys generate testnet-deployer
   ```
2. Fund the account with testnet XLM using friendbot:
   ```bash
   stellar friendbot --account <your-public-key> --network testnet
   ```

### 2. Set Environment Variables

```bash
# Set your deployer secret key
export KOVARA_DEPLOYER_SECRET=<your-secret-key>
```

### 3. Deploy to Testnet

```bash
# Navigate to contracts directory
cd packages/contracts

# Run the deployment script
bash scripts/deploy_testnet.sh
```

This script deploys all contracts in dependency order and writes their deployed addresses to `packages/contracts/deployed/testnet.json`.

### 4. Seed Testnet with Sample Data

After deployment, you can seed the testnet with sample submissions and data:

```bash
bash scripts/seed_testnet.sh
```

### Testnet Contract Addresses

Once deployed, you can find the contract addresses in `deployed/testnet.json`. You can view these contracts on the Stellar testnet explorer:

- https://stellar.expert/explorer/testnet

## Connecting to Testnet from Apps

### Configure Network Context

Both the web and mobile apps use the `NetworkContext` to connect to Stellar networks. To use testnet:

1. In `apps/web/config.ts` or `apps/mobile/config.ts`, set the network to testnet:

   ```typescript
   export const STELLAR_NETWORK = "testnet";
   export const RPC_URL = "https://soroban-testnet.stellar.org";
   ```

2. The app will automatically use the testnet contract addresses from your deployment file.

### Wallet Setup for Testnet

- **Freighter Wallet**: In Freighter settings, switch the network to "Testnet"
- Create a new testnet wallet to interact with your deployed contracts
- Fund your testnet wallet using friendbot: https://laboratory.stellar.org/#account-creator?network=test

## Troubleshooting

### Common Sandbox Issues

1. **Sandbox fails to start**
   - Ensure Docker is running
   - Check if port 8000 is already in use: `lsof -i :8000`
   - Stop any existing sandbox instance: `stellar sandbox stop`
   - Remove old sandbox volumes: `stellar sandbox reset`

2. **Contract deployment fails**
   - Verify your account has sufficient testnet XLM (minimum 1 XLM for deployment)
   - Check that the WASM file was built correctly
   - Ensure you're using the correct RPC URL for your network

3. **Integration tests fail to start**
   - Verify Docker is running and you have sufficient permissions
   - Check that you have the correct version of stellar-cli: `stellar --version`
   - Ensure no other sandbox is running on port 8000

### Common Testnet Issues

1. **Transactions fail with insufficient fees**
   - Ensure your account has enough testnet XLM (Soroban transactions require additional fees)
   - Fund your account again with friendbot

2. **Contract calls revert with authorization errors**
   - Verify the wallet is correctly connected to testnet
   - Ensure the contract address in your app matches the deployed address
   - Check that the transaction is correctly signed by the required authorizer

### Getting Help

If you encounter issues not covered here, please:

1. Check the [Soroban documentation](https://developers.stellar.org/docs/build/soroban)
2. Open an issue in the Kovara repository
3. Reach out to the core team in our Discord community
