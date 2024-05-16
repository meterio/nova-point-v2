import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { ConfigService } from "@nestjs/config";
import BigNumber from "bignumber.js";
import { Worker } from "../common/worker";
import {
  PointsOfLpRepository,
  BlockRepository,
  BalanceOfLpRepository,
  BlockTokenPriceRepository,
  BlockAddressPointOfLpRepository,
  AddressFirstDepositRepository,
} from "../repositories";
import { TokenMultiplier, TokenService } from "../token/token.service";
import { getETHPrice, getTokenPrice, STABLE_COIN_TYPE } from "./depositPoint.service";
import { hexTransformer } from "../transformers/hex.transformer";
import { BalanceOfLpDto } from "../repositories/balanceOfLp.repository";
import { PointsOfLp, AddressFirstDeposit } from "src/entities";
import addressMultipliers from "../addressMultipliers";
import { BoosterService } from "../booster/booster.service";

export const LOYALTY_BOOSTER_FACTOR: BigNumber = new BigNumber(0.005);
type BlockAddressTvl = {
  tvl: BigNumber;
  holdBasePoint: BigNumber;
};

@Injectable()
export class TvlPointService extends Worker {
  private readonly logger: Logger;
  private readonly type: string = "tvl";
  private readonly addressMultipliersCache: Map<string, TokenMultiplier[]>;

  public constructor(
    private readonly tokenService: TokenService,
    private readonly pointsOfLpRepository: PointsOfLpRepository,
    private readonly blockRepository: BlockRepository,
    private readonly blockTokenPriceRepository: BlockTokenPriceRepository,
    private readonly blockAddressPointOfLpRepository: BlockAddressPointOfLpRepository,
    private readonly balanceOfLpRepository: BalanceOfLpRepository,
    private readonly addressFirstDepositRepository: AddressFirstDepositRepository,
    private readonly boosterService: BoosterService,
    private readonly configService: ConfigService
  ) {
    super();
    this.logger = new Logger(TvlPointService.name);
    this.addressMultipliersCache = new Map<string, TokenMultiplier[]>();
    for (const m of addressMultipliers) {
      this.addressMultipliersCache.set(m.address.toLowerCase(), m.multipliers);
    }
  }

  @Cron("0 2,10,18 * * *")
  protected async runProcess(): Promise<void> {
    this.logger.log(`${TvlPointService.name} initialized`);
    try {
      await this.handleHoldPoint();
    } catch (error) {
      this.logger.error("Failed to calculate hold point", error.stack);
    }
  }

  async handleHoldPoint(exeBlockNumber?: number, exeBlockTimestamp?: string) {
    // get last balance of lp statistical block number
    const lastBalanceOfLp = await this.balanceOfLpRepository.getLastOrderByBlock();
    if (!lastBalanceOfLp) {
      this.logger.log(`No balance of lp found`);
      return;
    }
    const lastStatisticalBlockNumber = exeBlockNumber ? exeBlockNumber : lastBalanceOfLp.blockNumber;
    const currentStatisticalBlock = await this.blockRepository.getLastBlock({
      where: { number: lastStatisticalBlockNumber },
      select: { number: true, timestamp: true },
    });
    if (!currentStatisticalBlock) {
      this.logger.log(`No block of lp found, block number : ${lastStatisticalBlockNumber}`);
      return;
    }
    this.logger.log(`Start calculate tvl points at blockNumber:${currentStatisticalBlock.number}`);
    const statisticStartTime = new Date();
    // get the early bird weight
    const earlyBirdMultiplier = this.boosterService.getEarlyBirdMultiplier(currentStatisticalBlock.timestamp);
    this.logger.log(`Early bird multiplier: ${earlyBirdMultiplier}`);
    const tokenPriceMap = await this.getTokenPriceMap(currentStatisticalBlock.number);
    const blockTs = currentStatisticalBlock.timestamp.getTime();
    const addressTvlMap = await this.getAddressTvlMap(currentStatisticalBlock.number, blockTs, tokenPriceMap);
    this.logger.log(`Address tvl map size: ${addressTvlMap.size}`);
    let addresses: Array<string> = [];
    for (const key of addressTvlMap.keys()) {
      const [address, _] = key.split("-");
      if (!addresses.includes(address)) {
        addresses.push(address);
      }
    }
    this.logger.log(`Address list size: ${addresses.length}`);
    // get all first deposit time
    const addressFirstDepositList = await this.addressFirstDepositRepository.getAllAddressesFirstDeposits(addresses);
    this.logger.log(`Address first deposit map size: ${addressFirstDepositList.length}`);
    const addressFirstDepositMap: { [address: string]: AddressFirstDeposit } = {};
    for (let i = 0; i < addressFirstDepositList.length; i++) {
      const item = addressFirstDepositList[i];
      const tmpAddress = item.address.toLocaleLowerCase();
      if (tmpAddress) {
        addressFirstDepositMap[tmpAddress] = item;
      }
    }
    // get all point of lp by addresses
    const addressPointList = await this.pointsOfLpRepository.getPointByAddresses(addresses);
    this.logger.log(`Address point map size: ${addressPointList.length}`);
    let addressPointMap: { [address: string]: PointsOfLp } = {};
    for (let i = 0; i < addressPointList.length; i++) {
      const item = addressPointList[i];
      const tmpAddress = item.address.toLocaleLowerCase();
      const tmpPairAddress = item.pairAddress.toLocaleLowerCase();
      if (tmpAddress && tmpPairAddress) {
        const key = `${tmpAddress}-${tmpPairAddress}`;
        addressPointMap[key] = item;
      }
    }
    // loop all address to calculate hold point
    let blockAddressPointArr = [];
    let addressPointArr = [];
    let groupBooster = new BigNumber(1.5);
    for (const key of addressTvlMap.keys()) {
      const [address, pairAddress] = key.split("-");
      const addressTvl = addressTvlMap.get(key);
      if (!addressTvl) continue
      // get the last multiplier before the block timestamp
      const addressMultiplier = this.getAddressMultiplier(pairAddress, blockTs);
      const addressFirstDeposit = addressFirstDepositMap[address.toLowerCase()];
      const firstDepositTime = addressFirstDeposit?.firstDepositTime;
      const loyaltyBooster = this.boosterService.getLoyaltyBooster(blockTs, firstDepositTime?.getTime());

      const newHoldPoint = addressTvl?.holdBasePoint
        .multipliedBy(earlyBirdMultiplier)
        // use pairAddress caculate the groupBooster addressMultiplier loyaltyBooster
        .multipliedBy(groupBooster)
        .multipliedBy(addressMultiplier)
        .multipliedBy(loyaltyBooster);
      let fromBlockAddressPoint = {};
      if (exeBlockTimestamp) {
        fromBlockAddressPoint = {
          blockNumber: currentStatisticalBlock.number,
          address: address,
          pairAddress: pairAddress,
          holdPoint: newHoldPoint.toNumber(),
          createdAt: exeBlockTimestamp,
          updatedAt: exeBlockTimestamp,
        };
      } else {
        fromBlockAddressPoint = {
          blockNumber: currentStatisticalBlock.number,
          address: address,
          pairAddress: pairAddress,
          holdPoint: newHoldPoint.toNumber(),
        };
      }
      blockAddressPointArr.push(fromBlockAddressPoint);
      // let fromAddressPoint = await this.pointsOfLpRepository.getPointByAddress(address, pairAddress);
      let fromAddressPoint = addressPointMap[key];
      if (!fromAddressPoint) {
        fromAddressPoint = {
          id: 0,
          address: address,
          pairAddress: pairAddress,
          stakePoint: 0,
        };
      }
      fromAddressPoint.stakePoint = Number(fromAddressPoint.stakePoint) + newHoldPoint.toNumber();
      addressPointArr.push(fromAddressPoint);
      this.logger.log(
        `address:${address}, pairAddress:${pairAddress}, fromAddressPoint: ${JSON.stringify(fromAddressPoint)}`
      );
    }
    this.logger.log(`Start insert into db for block: ${currentStatisticalBlock.number}`);
    await this.blockAddressPointOfLpRepository.addManyIgnoreConflicts(blockAddressPointArr);
    this.logger.log(
      `Finish blockAddressPointArr for block: ${currentStatisticalBlock.number}, length: ${blockAddressPointArr.length}`
    );
    await this.pointsOfLpRepository.addManyOrUpdate(addressPointArr, ["stakePoint"], ["address", "pairAddress"]);
    this.logger.log(
      `Finish addressPointArr for block: ${currentStatisticalBlock.number}, length: ${addressPointArr.length}`
    );
    await this.pointsOfLpRepository.setHoldPointStatisticalBlockNumber(currentStatisticalBlock.number);
    const statisticEndTime = new Date();
    const statisticElapsedTime = statisticEndTime.getTime() - statisticStartTime.getTime();
    this.logger.log(
      `Finish hold point statistic for block: ${currentStatisticalBlock.number}, elapsed time: ${statisticElapsedTime / 1000
      } seconds`
    );
  }

  async getAddressTvlMap(
    blockNumber: number,
    blockTs: number,
    tokenPriceMap: Map<string, BigNumber>
  ): Promise<Map<string, BlockAddressTvl>> {
    const addressTvlMap: Map<string, BlockAddressTvl> = new Map();
    const blockNumbers = [blockNumber];
    const balanceList = await this.balanceOfLpRepository.getAllByBlocks(blockNumbers);
    this.logger.log(`The all address list length: ${balanceList.length}`);
    let balanceMap = new Map<string, BalanceOfLpDto[]>();
    for (let index = 0; index < balanceList.length; index++) {
      const balance = balanceList[index];
      const address = hexTransformer.from(balance.address);
      const pairAddress = hexTransformer.from(balance.pairAddress);
      const key = `${address}-${pairAddress}`;
      if (balanceMap.has(key)) {
        balanceMap.get(key).push(balance);
      } else {
        balanceMap.set(key, [balance]);
      }
    }
    for (const [key, value] of balanceMap) {
      const addressTvl = await this.calculateAddressTvl(value, tokenPriceMap, blockTs);
      if (addressTvl.holdBasePoint.isZero()) {
        continue;
      }
      addressTvlMap.set(key, addressTvl);
    }
    return addressTvlMap;
  }

  // find the latest multiplier before the block timestamp
  public getAddressMultiplier(address: string, blockTs: number): BigNumber {
    const multipliers = this.addressMultipliersCache.get(address.toLowerCase());
    if (!multipliers || multipliers.length == 0) {
      return new BigNumber(1);
    }
    multipliers.sort((a, b) => b.timestamp - a.timestamp);
    for (const m of multipliers) {
      if (blockTs >= m.timestamp * 1000) {
        return new BigNumber(m.multiplier);
      }
    }
    return new BigNumber(multipliers[multipliers.length - 1].multiplier);
  }

  async calculateAddressTvl(
    addressBalances: BalanceOfLpDto[],
    tokenPrices: Map<string, BigNumber>,
    blockTs: number
  ): Promise<BlockAddressTvl> {
    let tvl: BigNumber = new BigNumber(0);
    let holdBasePoint: BigNumber = new BigNumber(0);
    for (const addressBalance of addressBalances) {
      // filter not support token
      const tokenAddress: string = hexTransformer.from(addressBalance.tokenAddress);
      const tokenInfo = this.tokenService.getSupportToken(tokenAddress);
      if (!tokenInfo) {
        continue;
      }
      const tokenPrice = getTokenPrice(tokenInfo, tokenPrices);
      const ethPrice = getETHPrice(tokenPrices);
      const tokenAmount = new BigNumber(addressBalance.balance).dividedBy(new BigNumber(10).pow(tokenInfo.decimals));
      const tokenTvl = tokenAmount.multipliedBy(tokenPrice).dividedBy(ethPrice);
      // base point = Token Multiplier * Token Amount * Token Price / ETH_Price
      const tokenMultiplier = this.tokenService.getTokenMultiplier(tokenInfo, blockTs);
      const tokenHoldBasePoint = tokenTvl.multipliedBy(new BigNumber(tokenMultiplier));
      tvl = tvl.plus(tokenTvl);
      holdBasePoint = holdBasePoint.plus(tokenHoldBasePoint);
    }
    return {
      tvl,
      holdBasePoint,
    };
  }

  async getTokenPriceMap(blockNumber: number): Promise<Map<string, BigNumber>> {
    const allSupportTokens = this.tokenService.getAllSupportTokens();
    const allPriceIds: Set<string> = new Set();
    // do not need to get the price of stable coin(they are default 1 usd)
    allSupportTokens.map((t) => {
      if (t.type !== STABLE_COIN_TYPE) {
        allPriceIds.add(t.cgPriceId);
      }
    });
    const tokenPrices: Map<string, BigNumber> = new Map();
    for (const priceId of allPriceIds) {
      const blockTokenPrice = await this.blockTokenPriceRepository.getBlockTokenPrice(blockNumber, priceId);
      if (!blockTokenPrice) {
        throw new Error(`BlockNumber : ${blockNumber}, Token ${priceId} price not found`);
      }
      tokenPrices.set(priceId, new BigNumber(blockTokenPrice.usdPrice));
    }
    return tokenPrices;
  }
}
