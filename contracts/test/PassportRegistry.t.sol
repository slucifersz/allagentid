// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PassportRegistry} from "../src/PassportRegistry.sol";

contract PassportRegistryTest is Test {
    PassportRegistry reg;
    address owner = makeAddr("owner");
    address nova = makeAddr("nova");
    address pixel = makeAddr("pixel");
    address ghost = makeAddr("ghost");
    address stranger = makeAddr("stranger");

    function setUp() public {
        reg = new PassportRegistry();
        vm.prank(owner);
        reg.register("nova.agent", nova);
        reg.registerFor(makeAddr("pixelOwner"), "pixel.design", pixel);
        reg.registerFor(makeAddr("ghostOwner"), "ghost.design", ghost);
        reg.setTier(pixel, 2);
    }

    function test_registerAndResolve() public view {
        assertEq(reg.resolve("nova.agent"), nova);
        PassportRegistry.Passport memory p = reg.passportOf(nova);
        assertEq(p.owner, owner);
        assertEq(p.handle, "nova.agent");
        assertEq(reg.passportCount(), 3);
    }

    function test_handleRules() public {
        vm.expectRevert(PassportRegistry.HandleTaken.selector);
        reg.registerFor(owner, "nova.agent", makeAddr("x"));
        vm.expectRevert(PassportRegistry.InvalidHandle.selector);
        reg.registerFor(owner, "Nova", makeAddr("y"));
        vm.expectRevert(PassportRegistry.InvalidHandle.selector);
        reg.registerFor(owner, ".nova", makeAddr("z"));
        vm.expectRevert(PassportRegistry.AlreadyRegistered.selector);
        reg.registerFor(owner, "nova2", nova);
    }

    function test_onlyAttesterSetsTier() public {
        vm.prank(stranger);
        vm.expectRevert(PassportRegistry.NotAttester.selector);
        reg.setTier(nova, 2);
    }

    function test_onlyOwnerOrAttesterSetsPolicy() public {
        vm.prank(stranger);
        vm.expectRevert(PassportRegistry.NotOwnerOrAttester.selector);
        reg.setPolicy(nova, 1, 1, 0);
        vm.prank(owner);
        reg.setPolicy(nova, 5e6, 20e6, 1);
        assertEq(reg.policyOf(nova).perTxLimit, 5e6);
    }

    function test_checkPayment() public {
        vm.prank(owner);
        reg.setPolicy(nova, 5e6, 8e6, 1);

        (bool ok, uint8 reason) = reg.checkPayment(nova, pixel, 2e6);
        assertTrue(ok);
        assertEq(reason, 0);

        (ok, reason) = reg.checkPayment(nova, ghost, 1e6);
        assertEq(reason, 3); // ghost is unverified

        (ok, reason) = reg.checkPayment(nova, pixel, 6e6);
        assertEq(reason, 4); // over per-payment limit

        (ok, reason) = reg.checkPayment(nova, stranger, 1e6);
        assertEq(reason, 2); // no passport

        reg.recordSettlement(keccak256("p1"), nova, pixel, 5e6, bytes32(0));
        (ok, reason) = reg.checkPayment(nova, pixel, 4e6);
        assertEq(reason, 5); // 5 + 4 > 8 daily

        vm.warp(block.timestamp + 1 days);
        (ok,) = reg.checkPayment(nova, pixel, 4e6);
        assertTrue(ok); // new day
    }

    function test_settlementLedger() public {
        reg.recordSettlement(keccak256("p1"), nova, pixel, 2e6, bytes32(uint256(1)));
        assertEq(reg.passportOf(nova).volumePaid, 2e6);
        assertEq(reg.passportOf(pixel).settlementsReceived, 1);
        assertEq(reg.spentToday(nova), 2e6);
        vm.expectRevert(PassportRegistry.AlreadySettled.selector);
        reg.recordSettlement(keccak256("p1"), nova, pixel, 2e6, bytes32(0));
    }
}
