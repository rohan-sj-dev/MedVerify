// The MedTrace smart contract: the registry rules from src/ledger.js, on-chain.

import { Context, Contract, Info, Returns, Transaction } from 'fabric-contract-api';

import { NEXT, WHO } from './lifecycle';
import type { Batch, Drug, Role, Unit, UnitStatus } from './types';

@Info({ title: 'MedTrace', description: 'MedVerify medicine registry' })
export class MedTraceContract extends Contract {
  constructor() {
    super('MedTrace');
  }

//writes

  @Transaction()
  async RegisterDrug(ctx: Context, gtin: string, brandName: string, salt: string): Promise<void> {
    this.requireRole(ctx, ['manufacturer', 'regulator']);
    if (await this.get(ctx, 'drug', gtin)) throw new Error(`drug ${gtin} already exists`);

    const drug: Drug = { gtin, brandName, salt };
    await this.put(ctx, 'drug', gtin, drug);
  }

  @Transaction()
  async CreateBatch(ctx: Context, batchId: string, gtin: string, mfgDate: string, expiryDate: string): Promise<void> {
    const actor = this.requireRole(ctx, ['manufacturer']);
    if (!(await this.get(ctx, 'drug', gtin))) throw new Error(`no drug ${gtin}`);
    if (await this.get(ctx, 'batch', batchId)) throw new Error(`batch ${batchId} already exists`);

    const batch: Batch = { batchId, gtin, mfgDate, expiryDate, manufacturerId: actor.org, status: 'ACTIVE' };
    await this.put(ctx, 'batch', batchId, batch);
  }

  @Transaction()
  async CommissionUnit(ctx: Context, batchId: string, serialHash: string): Promise<void> {
    const actor = this.requireRole(ctx, ['manufacturer']);
    const batch = await this.get<Batch>(ctx, 'batch', batchId);
    if (!batch) throw new Error(`no batch ${batchId}`);
    if (batch.manufacturerId !== actor.org) throw new Error('only the batch manufacturer may add units');
    if (batch.status === 'RECALLED') throw new Error(`batch ${batchId} is recalled`);
    if (await this.get(ctx, 'unit', serialHash)) throw new Error('unit already exists');

    const unit: Unit = { serialHash, batchId, status: 'COMMISSIONED' };
    await this.put(ctx, 'unit', serialHash, unit);
  }

  @Transaction()
  async ChangeStatus(ctx: Context, serialHash: string, status: string): Promise<void> {
    const actor = this.actor(ctx);
    const unit = await this.get<Unit>(ctx, 'unit', serialHash);
    if (!unit) throw new Error('no such unit');

    const next = status as UnitStatus;
    if (!NEXT[unit.status]?.includes(next)) throw new Error(`${unit.status} -> ${status} is not allowed`);
    const allowed = unit.status === 'SUSPENDED' ? ['regulator'] : (WHO[next] ?? []);
    if (!allowed.includes(actor.role)) throw new Error(`a ${actor.role} may not set ${status}`);

    unit.status = next;
    await this.put(ctx, 'unit', serialHash, unit);
    // left to implement - record a custody event when the pack changes hands
  }

  @Transaction()
  async RecallBatch(ctx: Context, batchId: string): Promise<void> {
    const actor = this.actor(ctx);
    const batch = await this.get<Batch>(ctx, 'batch', batchId);
    if (!batch) throw new Error(`no batch ${batchId}`);
    const ownMaker = actor.role === 'manufacturer' && actor.org === batch.manufacturerId;
    if (actor.role !== 'regulator' && !ownMaker) throw new Error(`a ${actor.role} may not recall ${batchId}`);

    batch.status = 'RECALLED';
    await this.put(ctx, 'batch', batchId, batch);
    // left to implement - mark every unit of the batch RECALLED.
  }

// reads

  @Transaction(false)
  @Returns('string')
  async GetDrug(ctx: Context, gtin: string): Promise<string> {
    return JSON.stringify(await this.mustGet(ctx, 'drug', gtin));
  }

  @Transaction(false)
  @Returns('string')
  async GetBatch(ctx: Context, batchId: string): Promise<string> {
    return JSON.stringify(await this.mustGet(ctx, 'batch', batchId));
  }

  @Transaction(false)
  @Returns('string')
  async GetUnit(ctx: Context, serialHash: string): Promise<string> {
    return JSON.stringify(await this.mustGet(ctx, 'unit', serialHash));
  }




  private actor(ctx: Context): { org: string; role: Role } {
    const org = ctx.clientIdentity.getAttributeValue('medverify.org');
    const role = ctx.clientIdentity.getAttributeValue('medverify.role');
    if (!org || !role) throw new Error('certificate is missing medverify.org / medverify.role');
    return { org, role: role as Role };
  }

  private requireRole(ctx: Context, roles: Role[]): { org: string; role: Role } {
    const actor = this.actor(ctx);
    if (!roles.includes(actor.role)) throw new Error(`a ${actor.role} may not do this`);
    return actor;
  }

  private async get<T>(ctx: Context, type: string, id: string): Promise<T | null> {
    const bytes = await ctx.stub.getState(ctx.stub.createCompositeKey(type, [id]));
    return bytes && bytes.length > 0 ? (JSON.parse(Buffer.from(bytes).toString()) as T) : null;
  }

  private async mustGet<T>(ctx: Context, type: string, id: string): Promise<T> {
    const value = await this.get<T>(ctx, type, id);
    if (!value) throw new Error(`no ${type} ${id}`);
    return value;
  }

  private async put(ctx: Context, type: string, id: string, value: object): Promise<void> {
    await ctx.stub.putState(ctx.stub.createCompositeKey(type, [id]), Buffer.from(JSON.stringify(value)));
  }
}