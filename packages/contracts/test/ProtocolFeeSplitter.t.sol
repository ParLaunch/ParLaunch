// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BaseTest} from "./utils/BaseTest.sol";
import {ProtocolFeeSplitter} from "../src/ProtocolFeeSplitter.sol";

contract ProtocolFeeSplitterTest is BaseTest {
    ProtocolFeeSplitter internal splitter;
    address internal treasury = makeAddr("treasury");
    address internal flywheelSink = makeAddr("flywheelSink");
    address internal token;

    uint256 internal constant TREASURY_BPS = 7500; // 75% of the protocol's 40% = 30% of total

    function setUp() public override {
        super.setUp();
        splitter = new ProtocolFeeSplitter(
            address(locker),
            treasury,
            flywheelSink,
            TREASURY_BPS
        );
        vm.prank(admin);
        locker.setProtocolFeeRecipient(address(splitter));
        token = launchDefault();
        vm.roll(block.number + RESTRICTION_BLOCKS + 1);
    }

    function _tradeAndCollect() internal {
        buy(trader, token, 5 ether, 0);
        sell(trader, token, IERC20(token).balanceOf(trader) / 2, 0);
        locker.collectFees(token);
    }

    function test_constructorValidation() public {
        vm.expectRevert(ProtocolFeeSplitter.ZeroAddress.selector);
        new ProtocolFeeSplitter(address(0), treasury, flywheelSink, TREASURY_BPS);
        vm.expectRevert(abi.encodeWithSelector(ProtocolFeeSplitter.BadBps.selector, 10_001));
        new ProtocolFeeSplitter(address(locker), treasury, flywheelSink, 10_001);
    }

    function test_sweepPushesFlywheelHoldsTreasury() public {
        _tradeAndCollect();
        uint256 accrued = locker.claimable(address(splitter), address(wnative));
        assertGt(accrued, 0, "protocol share should accrue to the splitter");

        uint256 toFlywheel = splitter.sweep(address(wnative));
        uint256 expectedTreasury = (accrued * TREASURY_BPS) / 10_000;
        assertEq(toFlywheel, accrued - expectedTreasury, "flywheel cut pushed immediately");
        assertEq(IERC20(address(wnative)).balanceOf(flywheelSink), toFlywheel);
        // treasury cut is HELD, not sent
        assertEq(IERC20(address(wnative)).balanceOf(treasury), 0, "nothing pushed to treasury");
        assertEq(splitter.treasuryHeld(address(wnative)), expectedTreasury);
        assertEq(locker.claimable(address(splitter), address(wnative)), 0);
    }

    function test_onlyTreasuryCanClaim() public {
        _tradeAndCollect();
        splitter.sweep(address(wnative));
        vm.prank(trader);
        vm.expectRevert(ProtocolFeeSplitter.NotTreasury.selector);
        splitter.claimTreasury(address(wnative));
    }

    function test_treasuryClaimsWhenItWants() public {
        _tradeAndCollect();
        splitter.sweep(address(wnative));
        uint256 held = splitter.treasuryHeld(address(wnative));
        assertGt(held, 0);

        // more volume accrues while treasury waits — nothing is lost
        buy(trader2, token, 2 ether, 0);
        locker.collectFees(token);

        vm.prank(treasury);
        uint256 claimed = splitter.claimTreasury(address(wnative));
        assertGt(claimed, held, "claim folds in fees accrued since the last sweep");
        assertEq(IERC20(address(wnative)).balanceOf(treasury), claimed);
        assertEq(splitter.treasuryHeld(address(wnative)), 0);
    }

    function test_overallSplitIs60_30_10() public {
        _tradeAndCollect();
        uint256 creatorShare = locker.claimable(creatorFees, address(wnative));
        uint256 protocolShare = locker.claimable(address(splitter), address(wnative));
        uint256 total = creatorShare + protocolShare;

        uint256 toFlywheel = splitter.sweep(address(wnative));
        vm.prank(treasury);
        uint256 toTreasury = splitter.claimTreasury(address(wnative));

        // creator 60% of collected fees; treasury 30%; flywheel 10% (±1 wei rounding)
        assertApproxEqAbs(creatorShare, (total * 6000) / 10_000, 1);
        assertApproxEqAbs(toTreasury, (total * 3000) / 10_000, 1);
        assertApproxEqAbs(toFlywheel, (total * 1000) / 10_000, 1);
    }

    function test_sweepHandlesTokenCurrencyToo() public {
        _tradeAndCollect();
        uint256 accrued = locker.claimable(address(splitter), token);
        assertGt(accrued, 0, "buys pay fees in the launched token");
        uint256 toFlywheel = splitter.sweep(token);
        assertEq(IERC20(token).balanceOf(flywheelSink), toFlywheel);
        assertEq(splitter.treasuryHeld(token), accrued - toFlywheel);
    }

    function test_sweepWithNothingAccruedIsANoop() public {
        assertEq(splitter.sweep(address(wnative)), 0);
        assertEq(splitter.treasuryHeld(address(wnative)), 0);
    }

    function test_repeatSweepDoesNotDoubleCountHeldFunds() public {
        _tradeAndCollect();
        splitter.sweep(address(wnative));
        uint256 heldAfterFirst = splitter.treasuryHeld(address(wnative));
        uint256 flywheelAfterFirst = IERC20(address(wnative)).balanceOf(flywheelSink);
        // sweeping again with no new fees must change nothing
        assertEq(splitter.sweep(address(wnative)), 0);
        assertEq(splitter.treasuryHeld(address(wnative)), heldAfterFirst);
        assertEq(IERC20(address(wnative)).balanceOf(flywheelSink), flywheelAfterFirst);
    }

    function test_sweepSplitsDirectDonations() public {
        vm.deal(address(this), 1 ether);
        wnative.deposit{value: 1 ether}();
        IERC20(address(wnative)).transfer(address(splitter), 1 ether);
        uint256 toFlywheel = splitter.sweep(address(wnative));
        assertEq(toFlywheel, 0.25 ether);
        assertEq(splitter.treasuryHeld(address(wnative)), 0.75 ether);
    }

    function test_treasuryClaimableView() public {
        _tradeAndCollect();
        uint256 pending = locker.claimable(address(splitter), address(wnative));
        assertEq(
            splitter.treasuryClaimable(address(wnative)),
            (pending * TREASURY_BPS) / 10_000,
            "view counts unclaimed locker fees before any sweep"
        );
        splitter.sweep(address(wnative));
        assertEq(
            splitter.treasuryClaimable(address(wnative)),
            splitter.treasuryHeld(address(wnative)),
            "view matches held funds after sweep"
        );
    }

    function test_sweepMany() public {
        _tradeAndCollect();
        address[] memory currencies = new address[](2);
        currencies[0] = address(wnative);
        currencies[1] = token;
        splitter.sweepMany(currencies);
        assertEq(locker.claimable(address(splitter), address(wnative)), 0);
        assertEq(locker.claimable(address(splitter), token), 0);
        assertGt(IERC20(address(wnative)).balanceOf(flywheelSink), 0);
        assertGt(splitter.treasuryHeld(token), 0);
    }
}
