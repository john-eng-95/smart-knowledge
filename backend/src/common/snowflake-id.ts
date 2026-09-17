import SnowflakeId from 'snowflake-id';

const snowflake = new SnowflakeId({
  mid: Number(process.env.SNOWFLAKE_WORKER_ID ?? 1),
  offset: Number(process.env.SNOWFLAKE_OFFSET ?? 1704067200000),
});

/** Generate a Snowflake ID string corresponding to PostgreSQL BIGINT. */
export function nextSnowflakeId(): string {
  return snowflake.generate();
}
