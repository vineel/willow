import { sendDigest } from "../digest";
import { sql } from "../config";

const result = await sendDigest();
console.log(result.sent ? `${result.count} items sent` : "Nothing to send");
await sql.end();
