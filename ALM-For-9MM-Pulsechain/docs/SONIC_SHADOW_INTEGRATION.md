# Integration Reference: Sonic Chain & Shadow.so DEX

**Objective**: This document provides a technical reference for the integration of the Sonic blockchain and the Shadow.so DEX into the automated liquidity manager.

**Date**: February 28, 2026

---

## 1. Technical Specifications

This section contains the key technical details for Sonic and Shadow.so.

### Sonic Blockchain

*   **Network Name**: Sonic
*   **Chain ID**: `146`
*   **Native Currency**: `S`
*   **Default Public RPC**: `https://rpc.soniclabs.com`
*   **Block Explorer**: `https://sonicscan.org`

### Shadow.so DEX

*   **DEX Lineage**: Shadow.so is a fork of the **Aerodrome CL / Slipstream** architecture.
    *   It uses `tickSpacing` as the primary pool identifier.
    *   It requires sequential RPC calls for pool state fetching due to using EIP-1167 minimal proxies.
    *   The project's existing `'aerodrome-cl'` logic path is used for this integration.

*   **Contract Addresses (Sonic Mainnet)**:
    *   **NonfungiblePositionManager**: `0xA57FA38b3fd45922394e9E1077748A2383F1542E`
    *   **SwapRouter**: `0x5543c6176feb9b4b179078205d7c29eea2e2d695`
    *   **Factory (`ShadowV3Factory`)**: `0xcD2d0637c94fe77C2896BbCBB174cefFb08DE6d7`
    *   **QuoterV2**: `0x219b7ADebc0935a3eC889a148c6924D51A07535A`

*   **Fee Tiers & Tick Spacings**: Uses `tickSpacing` as the primary pool identifier. Common tiers are `1`, `50`, `100`, `200`, and `2000`.

*   **Swap ABI**: The `exactInputSingle` function's parameter struct (`ExactInputSingleParams`) uses **`int24 tickSpacing`** instead of `uint24 fee` and includes a `deadline` parameter. This matches the existing `'aerodrome-cl'` implementation.

*   **Pool Proxy Pattern**: Shadow.so pools are deployed as **EIP-1167 minimal proxies**. This means batched RPC calls (like `Promise.all`) to a pool contract will fail. All pool state properties (`slot0`, `liquidity`, etc.) must be fetched sequentially.

### Token Addresses (Sonic Mainnet)

*   **Wrapped Sonic (wS)**: `0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38`
*   **USD Coin (USDC)**: `0x29219dd400f2Bf60E5a23d13Be72B486D4038894`

### DEX Aggregators

*   At the time of integration, there were **no known DEX aggregators** supported by the bot's architecture on the Sonic network. All swaps must be performed directly via the Shadow.so `SwapRouter`.
