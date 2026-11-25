// @vitest-environment jsdom
import {it,expect} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {Ownership} from "./ownership.mjs";

it("locates and runs its plain Node reaper under a browser-aware test transform, then joins before removing scratch",async()=>{
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),"owned-jsdom-profile-"));
 let owner:Awaited<ReturnType<typeof Ownership.open>>|undefined;
 try {
  owner=await Ownership.open({profileDir:profile,lifetime:"leased"});
  const scratch=await owner.scratch("browser-aware-proof-");
  const file=path.join(scratch,"actual-native-bytes");fs.writeFileSync(file,"retained until owned release");
  expect(fs.readFileSync(file,"utf8")).toBe("retained until owned release");
  await owner.release();owner=undefined;
  expect(fs.existsSync(scratch)).toBe(false);
 } finally {
  await owner?.release();
  fs.rmSync(profile,{recursive:true,force:true});
 }
},15000);
