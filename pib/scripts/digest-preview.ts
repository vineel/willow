import { previewDigest } from "../digest";
import { sql } from "../config";

const { text } = await previewDigest();
console.log(text);
await sql.end();
