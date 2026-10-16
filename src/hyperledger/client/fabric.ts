// Minimal connection to the MedTrace chaincode through a Fabric gateway peer.
//
//   const fabric = await connectToFabric({ ...settings });
//   await fabric.contract.submitTransaction('RegisterDrug', gtin, 'Dolo 650', 'Paracetamol');
//   const unit = JSON.parse(Buffer.from(await fabric.contract.evaluateTransaction('GetUnit', hash)).toString());
//   fabric.close();

import { createPrivateKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import * as grpc from '@grpc/grpc-js';
import { type Contract, connect, hash, signers } from '@hyperledger/fabric-gateway';

export interface FabricSettings {
  peerEndpoint: string;
  peerHostAlias: string;
  tlsCertPath: string;
  mspId: string;
  certPath: string;
  keyPath: string;
  channel: string;
  chaincode: string;
}

export async function connectToFabric(s: FabricSettings): Promise<{ contract: Contract; close: () => void }> {
  const client = new grpc.Client(s.peerEndpoint, grpc.credentials.createSsl(await readFile(s.tlsCertPath)), {
    'grpc.ssl_target_name_override': s.peerHostAlias,
  });

  const gateway = connect({
    client,
    identity: { mspId: s.mspId, credentials: await readFile(s.certPath) },
    signer: signers.newPrivateKeySigner(createPrivateKey(await readFile(s.keyPath))),
    hash: hash.sha256,
  });

  const contract = gateway.getNetwork(s.channel).getContract(s.chaincode);
  return {
    contract,
    close: () => {
      gateway.close();
      client.close();
    },
  };
}