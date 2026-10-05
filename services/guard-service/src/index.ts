import './bootstrap';

import config from 'config';

import { MultiSigUtils } from '@rosen-bridge/ergo-multi-sig';

import TxAgreement from './agreement/txAgreement';
import ArbitraryProcessor from './arbitrary/arbitraryProcessor';
import RosenDialer from './communication/rosenDialer';
import { readAvalancheBalanceConfig } from './configs/avalancheBalanceConfig';
import Configs from './configs/configs';
import { DatabaseAction } from './db/databaseAction';
import DatabaseHandler from './db/databaseHandler';
import { dataSource } from './db/dataSource';
import { getHealthCheck } from './guard/healthCheck';
import BalanceHandler from './handlers/balanceHandler';
import ChainHandler from './handlers/chainHandler';
import DetectionHandler from './handlers/detectionHandler';
import GuardPkHandler from './handlers/guardPkHandler';
import MinimumFeeHandler from './handlers/minimumFeeHandler';
import MultiSigHandler from './handlers/multiSigHandler';
import { NotificationHandler } from './handlers/notificationHandler';
import PublicStatusHandler from './handlers/publicStatusHandler';
import { TokenHandler } from './handlers/tokenHandler';
import TssHandler from './handlers/tssHandler';
import { initApiServer } from './jobs/apiServer';
import { initDataSources } from './jobs/dataSources';
import { configUpdateJob } from './jobs/guardConfigUpdate';
import { healthCheckStart } from './jobs/healthCheck';
import {
  getAvalancheScanner,
  initScanner,
  prepareAvalancheScanner,
  getPreparedAvalancheInputs,
  startScannerJobs,
} from './jobs/initScanner';
import { minimumFeeUpdateJob } from './jobs/minimumFee';
import { initializeMultiSigJobs } from './jobs/multiSig';
import { revenueJob } from './jobs/revenue';
import { runProcessors } from './jobs/runProcessors';
import { tssUpdateJob } from './jobs/tss';
import EventReprocess from './reprocess/eventReprocess';
import { createGuardSigningRuntime } from './signing/signingRuntime';
import EventSynchronization from './synchronization/eventSynchronization';
import TransactionProcessor from './transaction/transactionProcessor';
import * as TransactionSerializer from './transaction/transactionSerializer';
import { createAvalancheManagementDependencies } from './verification/avalancheManagementDependencies';
import RewardAuthorization from './verification/rewardAuthorization';

const init = async () => {
  // initialize tokens config
  await TokenHandler.init(Configs.tokensPath);

  // initialize NotificationHandler object
  NotificationHandler.setup();

  // initialize all data sources
  await initDataSources();

  // initialize DatabaseAction
  DatabaseAction.init(dataSource);
  await prepareAvalancheScanner();
  const avalancheInputs = getPreparedAvalancheInputs();
  if (avalancheInputs) await TokenHandler.getInstance().sealForAvalanche();
  ChainHandler.prepareStartup(avalancheInputs);

  const database = DatabaseAction.getInstance();
  const signing = createGuardSigningRuntime({
    getEvent: database.getEventById,
    getTx: database.getTxById,
    decode: (json) =>
      TransactionSerializer.fromJson(json, ChainHandler.getInstance().getChain),
    getScanner: getAvalancheScanner,
    curveTimeoutSeconds: Configs.curveSignTimeout,
    edwardTimeoutSeconds: Configs.edwardSignTimeout,
    ergoTimeoutSeconds: Configs.multiSigSignTimeout,
    maxPending: Configs.tssParallelSignCount,
    management: createAvalancheManagementDependencies({
      getInputs: () => avalancheInputs,
      getChain: () => ChainHandler.getInstance().getChain('avalanche'),
      getDatabase: () => DatabaseAction.getInstance(),
      decode: (json) =>
        TransactionSerializer.fromJson(
          json,
          ChainHandler.getInstance().getChain,
        ),
      getThresholds: Configs.thresholds,
      getWaitingTokens: DatabaseHandler.getWaitingEventsRequiredTokens,
      manualRequests: () => Configs.isManualTxRequestActive,
      arbitraryRequests: () => Configs.isArbitraryOrderRequestActive,
      guardsCount: () => GuardPkHandler.getInstance().guardsLen,
    }),
  });
  TransactionProcessor.initSigning(signing.context, signing.processor);
  RewardAuthorization.init(signing.context);

  // initialize PublicStatusHandler
  PublicStatusHandler.init(dataSource);

  // initialize Dialer
  await RosenDialer.init();

  // initialize DetectionHandler
  await DetectionHandler.init();

  // initialize multiSig utils object
  const multiSigUtils = new MultiSigUtils(() =>
    ChainHandler.getInstance().getErgoChain().getStateContext(),
  );
  // initialize tss multiSig object
  await MultiSigHandler.init(multiSigUtils, signing);

  // start tss instance
  await TssHandler.init(signing);

  // initialize chain objects
  await ChainHandler.initialize();

  // Register every extractor before exposing APIs or starting recurring work.
  await initScanner();

  // guard config update job
  const pkHandler = GuardPkHandler.getInstance();
  await pkHandler.update();
  pkHandler.updateDependentModules();

  // initialize TxAgreement object
  await TxAgreement.getInstance();

  // initialize ArbitraryProcessor object
  ArbitraryProcessor.getInstance();

  // initialize EventSynchronization object
  await EventSynchronization.init();

  // initialize EventReprocess object
  await EventReprocess.init();

  // initialize MinimumFeeHandler
  await MinimumFeeHandler.init(TokenHandler.getInstance().getTokenMap());

  // initialize BalanceHandler
  BalanceHandler.init(
    avalancheInputs
      ? readAvalancheBalanceConfig(
          config.has('balanceHandler.avalanche')
            ? config.get('balanceHandler.avalanche')
            : undefined,
        )
      : undefined,
  );

  // Validate and register all health parameters before exposing APIs or timers.
  await getHealthCheck();

  await initApiServer();
  initializeMultiSigJobs();
  tssUpdateJob();
  setTimeout(configUpdateJob, Configs.guardConfigUpdateInterval * 1000);
  minimumFeeUpdateJob();
  startScannerJobs();

  // run processors
  runProcessors();

  // initialize guard health check
  await healthCheckStart();

  // run revenue job
  await revenueJob();
};

export const initialization = init();
