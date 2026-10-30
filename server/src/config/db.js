import mongoose from 'mongoose';
import { ExtractedRecord, Campaign, MiscellaneousContact } from '../models/index.js';

export async function connectDatabase() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is required');
  }

  mongoose.set('strictQuery', true);

  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000
  });

  try {
    const collections = await mongoose.connection.db.listCollections(
      { name: /^(employees|employeeimports)$/ },
      { nameOnly: true }
    ).toArray();
    for (const collection of collections) {
      await mongoose.connection.db.dropCollection(collection.name);
      console.info(`Removed obsolete ${collection.name} collection`);
    }
    const miscIndexes = await MiscellaneousContact.collection.indexes();
    for (const index of miscIndexes) {
      if (index.name === 'staffId_1') await MiscellaneousContact.collection.dropIndex(index.name);
    }
    await MiscellaneousContact.collection.updateMany({}, { $unset: { staffId: '' } });
    await ExtractedRecord.collection.updateMany({}, { $unset: { staffId: '' } });
    await ExtractedRecord.collection.updateMany(
      {},
      { $unset: { employee: '', matchCandidates: '', matchStatus: '' } }
    );
    await Campaign.collection.updateMany(
      { 'recipients.staffId': { $exists: true } },
      { $unset: { 'recipients.$[].staffId': '' } }
    );
    await Campaign.collection.updateMany(
      {},
      { $unset: { 'recipients.$[].employee': '', 'recipients.$[].matchCandidates': '' } }
    );
  } catch (error) {
    console.warn('Legacy employee identifier migration warning:', error.message);
  }

  console.info('MongoDB connected');
}