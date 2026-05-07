import config from "./default.config.ts";
//export const config = Object.create(defaultConfig);
export { config };
const nodeEnv = process.env.NODE_ENV || 'development';
const configPath = process.env.RAPID_COMMUNITY_DATA_LAB_API_CONFIG_PATH || `../${nodeEnv}.config.ts`;
let actualConfig;
try {
  actualConfig = await import(configPath);
  console.log(`Loaded config from ${configPath}`);
  Object.assign(config, actualConfig.default);
} catch (error) {
}

