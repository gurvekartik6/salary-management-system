const appDbName = 'sggs_salary_notifications';
const appUser = process.env.MONGO_APP_USERNAME || 'sggsapp';
const appPassword = process.env.MONGO_APP_PASSWORD;
if (!appPassword || appPassword.length < 20) throw new Error('MONGO_APP_PASSWORD must be at least 20 characters');
const appDb = db.getSiblingDB(appDbName);
if (!appDb.getUser(appUser)) {
  appDb.createUser({ user: appUser, pwd: appPassword, roles: [{ role: 'readWrite', db: appDbName }] });
}
