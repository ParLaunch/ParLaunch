// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20MultiStockSell {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IPermit2MultiStockSell {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IUniversalRouterMultiStockSell {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// @notice Sells canonical Robinhood Stock Tokens back into USDG.
contract MultiStockSellExecutor {
    struct PathKey {
        address intermediateCurrency;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
        bytes hookData;
    }

    struct ExactInputParams {
        address currencyIn;
        PathKey[] path;
        uint256[] minHopPriceX36;
        uint128 amountIn;
        uint128 amountOutMinimum;
    }

    address public constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address public constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address public constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    address public constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address public constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;
    address public constant AAPL = 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9;
    address public constant MSFT = 0xe93237C50D904957Cf27E7B1133b510C669c2e74;
    address public constant SPY = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;
    address public constant META = 0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35;
    address public constant GOOGL = 0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3;

    bool private entered;

    event StockSold(
        address indexed seller,
        string symbol,
        address indexed stockToken,
        uint256 stockTokensSold,
        uint256 usdgReceived
    );

    error ReentrantCall();
    error UnsupportedStock(address token);
    error InvalidAmount();
    error DeadlineExpired();
    error TokenCallFailed();
    error InsufficientOutput(uint256 received, uint256 minimum);

    constructor() {
        _authorize(NVDA);
        _authorize(TSLA);
        _authorize(AAPL);
        _authorize(MSFT);
        _authorize(SPY);
        _authorize(META);
        _authorize(GOOGL);
    }

    function sellStock(
        address stockToken,
        uint256 stockIn,
        uint256 minUsdgOut,
        uint256 deadline
    ) external returns (uint256 received) {
        string memory symbol = symbolOf(stockToken);
        if (entered) revert ReentrantCall();
        if (stockIn == 0 || stockIn > type(uint128).max || minUsdgOut > type(uint128).max) {
            revert InvalidAmount();
        }
        if (block.timestamp > deadline) revert DeadlineExpired();
        entered = true;

        _safeTransferFrom(stockToken, msg.sender, address(this), stockIn);
        uint256 beforeBalance = IERC20MultiStockSell(USDG).balanceOf(address(this));

        PathKey[] memory path = new PathKey[](1);
        path[0] = PathKey({
            intermediateCurrency: USDG,
            fee: 3000,
            tickSpacing: 60,
            hooks: address(0),
            hookData: bytes("")
        });
        uint256[] memory minHopPriceX36 = new uint256[](0);
        ExactInputParams memory swap = ExactInputParams({
            currencyIn: stockToken,
            path: path,
            minHopPriceX36: minHopPriceX36,