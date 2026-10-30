// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {PassportRegistry} from "../src/PassportRegistry.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

/// Deploys PassportRegistry. On a local chain (31337) also deploys MockUSDC.
/// forge script script/Deploy.s.sol --rpc-url $RPC_URL --private-key $OPERATOR_PRIVATE_KEY --broadcast
contract Deploy is Script {
    function run() external {
        vm.startBroadcast();
        PassportRegistry reg = new PassportRegistry();
        console.log("PassportRegistry", address(reg));
        if (block.chainid == 31337) {
            MockUSDC usdc = new MockUSDC();
            console.log("MockUSDC", address(usdc));
        }
        vm.stopBroadcast();
    }
}
