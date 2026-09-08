#!/usr/bin/env python3
"""Browser integration tests. Run against localhost, or --inline in network-restricted environments.
Install test tooling separately: pip install playwright && playwright install chromium
No test dependencies are needed to run the editor itself.
"""
import argparse, asyncio, json, os
from pathlib import Path
from playwright.async_api import async_playwright
ROOT=Path(__file__).resolve().parents[1]

async def main(args):
 results=[];errors=[]
 output=Path(args.output_dir).resolve();output.mkdir(parents=True,exist_ok=True)
 async with async_playwright() as p:
  kwargs={'headless':True,'args':['--no-sandbox','--enable-unsafe-webgpu','--enable-unsafe-swiftshader','--use-angle=swiftshader']}
  executable=os.environ.get('CHROMIUM_EXECUTABLE')
  if executable: kwargs['executable_path']=executable
  browser=await p.chromium.launch(**kwargs)
  context=await browser.new_context(viewport={'width':1600,'height':1000},device_scale_factor=1,accept_downloads=True)
  page=await context.new_page()
  page.on('pageerror',lambda e: errors.append(str(e)))
  async def check(name,expression):
   value=await page.evaluate(expression)
   if not value:
    print('FAIL STATE',await page.evaluate('({nodes:vellum.doc.nodes.length,page:vellum.doc.page.name,backend:vellum.renderer.backend,visible:vellum.renderer.visibleCount,canvas:[vellum.renderer.width,vellum.renderer.height],camera:vellum.state.camera,gesture:vellum.state.gesture,errors:[]})'),flush=True)
    raise AssertionError(f'{name}: {value}')
   results.append({'name':name,'passed':True})
   print('PASS',name,flush=True)
  if args.inline:
   await page.set_content((ROOT/'Vellum.html').read_text(),wait_until='load')
  else:
   await page.goto(args.url,wait_until='networkidle')
  await page.wait_for_function('window.vellum?.ready')
  if args.expect_backend:
   actual=await page.evaluate('vellum.renderer.backend')
   if actual!=args.expect_backend: raise AssertionError(f'Expected {args.expect_backend}, got {actual}')
  await check('Editor initializes with real scene graph', 'vellum.doc.nodes.length===171 && vellum.doc.data.pages.length===3')
  await check('Renderer produces scene instances', 'vellum.renderer.instanceCount>150 && ["WebGPU","Canvas 2D"].includes(vellum.renderer.backend)')
  await page.locator('#dismiss-tip').click()
  await page.locator('[data-page]').last.click()
  await check('Page navigation', 'vellum.doc.page.name === "Playground" && vellum.doc.nodes.length===0')
  # Actual pointer creation, hit selection, movement, and geometry handles.
  canvas=await page.locator('#overlay').bounding_box()
  x,y=canvas['x']+200,canvas['y']+180
  await page.keyboard.press('r');await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+180,y+100,steps=5);await page.mouse.up()
  await check('Rectangle tool pointer drawing', 'vellum.doc.nodes.length===1 && vellum.doc.nodes[0].type==="rect" && Math.abs(vellum.doc.nodes[0].w-180)<1')
  await page.evaluate('window.testRect=vellum.doc.nodes[0].id; window.originalX=vellum.doc.get(testRect).x')
  await page.mouse.move(x+70,y+40);await page.mouse.down();await page.mouse.move(x+120,y+70,steps=5);await page.mouse.up()
  await check('Pointer dragging updates geometry', 'Math.abs(vellum.doc.get(testRect).x-originalX-50)<1')
  await page.keyboard.press('Control+z')
  await check('Undo restores transform', 'Math.abs(vellum.doc.get(testRect).x-originalX)<1')
  await page.keyboard.press('Control+Shift+z')
  await check('Redo reapplies transform', 'Math.abs(vellum.doc.get(testRect).x-originalX-50)<1')
  await page.locator('input[data-prop="w"]').fill('240');await page.locator('input[data-prop="w"]').press('Enter');await page.locator('input[data-prop="h"]').click()
  await check('Inspector dimension binding', 'vellum.doc.get(testRect).w===240')
  # Touch the resize handle at the actual transformed corner.
  pos=await page.evaluate('(()=>{const n=vellum.doc.get(testRect),w=vellum.doc.world(testRect),c=vellum.state.camera;return {x:(w.matrix[4]+n.w)*c.zoom+c.x,y:(w.matrix[5]+n.h)*c.zoom+c.y}})()')
  await page.mouse.move(canvas['x']+pos['x'],canvas['y']+pos['y']);await page.mouse.down();await page.mouse.move(canvas['x']+pos['x']+60,canvas['y']+pos['y']+30,steps=5);await page.mouse.up()
  await check('Canvas resize handles', 'Math.abs(vellum.doc.get(testRect).w-300)<1')
  await page.evaluate('vellum.select([testRect]); vellum.setProperty("rotation",30)')
  await check('Rotation transforms world bounds', 'vellum.doc.get(testRect).rotation===30 && vellum.doc.world(testRect).box.w>300')
  await page.evaluate('vellum.actions.duplicate()')
  await check('Deep duplication uses distinct IDs', 'vellum.doc.nodes.length===2 && new Set(vellum.doc.nodes.map(n=>n.id)).size===2')
  await page.evaluate('vellum.select(vellum.doc.nodes.map(n=>n.id)); vellum.actions.group()')
  await check('Grouping preserves hierarchy', 'vellum.doc.nodes.filter(n=>n.type==="group").length===1 && vellum.doc.nodes.filter(n=>n.parentId).length===2')
  await page.evaluate('vellum.actions.ungroup()')
  await check('Ungroup preserves children', 'vellum.doc.nodes.length===2 && vellum.doc.nodes.every(n=>!n.parentId)')
  # Real text-edit overlay with Unicode and wrapping.
  await page.evaluate('window.testText=vellum.createAtCenter("text",{text:"Typography test",w:340,h:80,fontSize:24}).id; vellum.fit([testText]);vellum.actions.editText()')
  await page.locator('#text-editor').fill('Vellum · Typography\nZażółć gęślą jaźń · مرحبا')
  await page.keyboard.press('Escape')
  await check('Multiline Unicode text editing commits', 'vellum.doc.get(testText).text.includes("مرحبا") && vellum.doc.get(testText).text.includes(String.fromCharCode(10)) && !vellum.state.editing')
  await page.evaluate('vellum.select([testText]);vellum.setProperty("fontSize",32);vellum.setProperty("fontWeight",700);vellum.setProperty("letterSpacing",1.2);vellum.setProperty("lineHeight",160);vellum.setProperty("textAlign","center");vellum.setProperty("direction","rtl");vellum.setProperty("textDecoration","underline")')
  await check('Typography properties bind to the document', '(()=>{let n=vellum.doc.get(testText);return n.fontSize===32&&n.fontWeight===700&&n.letterSpacing===1.2&&n.lineHeight===1.6&&n.textAlign==="center"&&n.direction==="rtl"&&n.textDecoration==="underline"})()')
  await page.evaluate('vellum.select([testRect]);vellum.actions.component();window.instanceCount=vellum.doc.nodes.length;vellum.instantiate(testRect);window.testInstance=[...vellum.state.selection][0]')
  await check('Components create linked instances', 'vellum.doc.nodes.length===instanceCount+1 && vellum.doc.get(testInstance).sourceId===testRect')
  await page.evaluate('vellum.select([testRect]);vellum.setProperty("fill","#ee7733")')
  await check('Main component changes propagate', 'vellum.doc.get(testInstance).fill==="#ee7733"')
  await page.evaluate('vellum.select([testInstance]);vellum.setProperty("fill","#33aa88");vellum.select([testRect]);vellum.setProperty("fill","#112233")')
  await check('Instance overrides survive source edits', 'vellum.doc.get(testInstance).fill==="#33aa88"')
  await page.evaluate('window.testFrame=vellum.createAtCenter("frame",{w:450,h:250,name:"Auto layout test"}).id;window.childA=vellum.createAtCenter("rect",{w:80,h:40}).id;window.childB=vellum.createAtCenter("rect",{w:90,h:50}).id;vellum.transaction("Arrange",()=>{vellum.doc.get(childA).parentId=testFrame;vellum.doc.get(childB).parentId=testFrame});vellum.select([testFrame]);vellum.setProperty("layout","horizontal");vellum.setProperty("gap",20);vellum.setProperty("padding",16)')
  await check('Horizontal auto layout and spacing', 'vellum.doc.get(childA).x===16 && vellum.doc.get(childB).x===116 && vellum.doc.get(childA).y===16')
  await page.evaluate('vellum.setProperty("layout","vertical")')
  await check('Vertical auto layout', 'vellum.doc.get(childB).y===76 && vellum.doc.get(childB).x===16')
  await page.evaluate('vellum.setProperty("layout","none");vellum.select([childA]);vellum.setProperty("constraintH","right");window.childOldX=vellum.doc.get(childA).x;vellum.select([testFrame]);vellum.setProperty("w",550)')
  await check('Frame resize constraints', 'vellum.doc.get(childA).x===childOldX+100')
  # Draw a real Bézier path through the UI.
  await page.evaluate('vellum.fit();vellum.select([])');await page.keyboard.press('p')
  await page.mouse.move(canvas['x']+200,canvas['y']+400);await page.mouse.down();await page.mouse.move(canvas['x']+240,canvas['y']+380);await page.mouse.up()
  await page.mouse.click(canvas['x']+350,canvas['y']+430);await page.mouse.click(canvas['x']+280,canvas['y']+530);await page.keyboard.press('Enter')
  await check('Pen creates editable Bézier geometry', 'vellum.doc.nodes.some(n=>n.type==="path"&&n.points.length===3&&!!n.points[0].out)')
  await page.evaluate('window.imageBefore=vellum.doc.nodes.length;window.imagePromise=vellum.importImage(new File([`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="#339966"/></svg>`],"test.svg",{type:"image/svg+xml"}))');await page.evaluate('imagePromise')
  await check('Image import embeds image data', 'vellum.doc.nodes.length===imageBefore+1 && vellum.doc.nodes.at(-1).type==="image" && Object.keys(vellum.doc.data.assets).length===1')
  await page.evaluate('window.originalImageId=vellum.doc.nodes.at(-1).assetId; window.documentBeforeImport=vellum.doc.serialize(); window.openTest=vellum.importDocument(new File([JSON.stringify({format:"vellum",version:1,name:"Empty import",pageId:"empty",pages:[{id:"empty",name:"Empty",nodes:[]}],assets:{}})],"empty.vellum",{type:"application/json"}))');await page.evaluate('openTest')
  await page.evaluate('vellum.actions.undo()')
  await check('Undo document replacement restores image assets', 'vellum.doc.nodes.some(n=>n.assetId===originalImageId) && vellum.doc.data.assets[originalImageId].startsWith("data:image/svg+xml")')
  await check('Portable JSON validates and round-trips', '(()=>{const s=vellum.doc.serialize(),d=vellum.doc.constructor.parse(s);return d.pages.length===3 && JSON.stringify(d.pages)===JSON.stringify(vellum.doc.data.pages)})()')
  await check('Cyclic document input is rejected', '(()=>{const d=JSON.parse(vellum.doc.serialize()),n=d.pages.find(p=>p.id===d.pageId).nodes[0];n.parentId=n.id;try{vellum.doc.constructor.parse(JSON.stringify(d));return false}catch{return true}})()')
  await check('HTML-injection layer IDs are rejected', '(()=>{const d=JSON.parse(vellum.doc.serialize());d.pages.find(p=>p.id===d.pageId).nodes[0].id=`"><img src=x onerror=alert(1)>`;try{vellum.doc.constructor.parse(JSON.stringify(d));return false}catch{return true}})()')
  await check('SVG export is well-formed and includes vector/text nodes', '(()=>{const roots=vellum.doc.nodes.filter(n=>!n.parentId).map(n=>n.id),svg=vellum.exportSVG(vellum.doc,roots),xml=new DOMParser().parseFromString(svg,"image/svg+xml");return !xml.querySelector("parsererror")&&!!xml.querySelector("text")&&!!xml.querySelector("path")&&!!xml.querySelector("image")})()')
  await check('PNG export produces real pixel content', '(async()=>{const c=await vellum.renderer.exportCanvas([testFrame],1);const d=c.getContext("2d").getImageData(10,10,1,1).data;return c.width===550&&c.height===250&&d[3]>0})()')
  await page.evaluate('vellum.select([testFrame]);vellum.actions.present()');await page.wait_for_selector('#presentation:not(.hidden)')
  await check('Frame presentation renders a preview', 'document.querySelector("#presentation-canvas").width>0 && !document.querySelector("#presentation").classList.contains("hidden")')
  await page.locator('#close-presentation').click()
  await page.locator('#theme-toggle').click()
  await check('Light appearance switches semantic tokens', 'document.documentElement.dataset.theme==="light"')
  await page.keyboard.press('Control+k');await page.locator('#command-search').fill('rulers');await page.keyboard.press('Enter')
  await check('Command palette executes commands', 'document.querySelector("#modal-backdrop").classList.contains("hidden")')
  await page.evaluate('vellum.actions.resetStarter();vellum.select([]);vellum.fit()');await page.wait_for_timeout(200)
  # Capture at multiple viewport sizes; render timing is CPU-only, not a FPS claim.
  await page.locator('#toast').evaluate('(el)=>el.classList.add("hidden")')
  await page.screenshot(path=str(output/'screenshot-light.png'))
  await page.evaluate('vellum.actions.theme()');await page.wait_for_timeout(150)
  await check('Dark appearance restores semantic tokens', 'document.documentElement.dataset.theme==="dark"')
  await page.screenshot(path=str(output/'screenshot-dark.png'))
  await page.set_viewport_size({'width':1280,'height':800});await page.evaluate('vellum.fit()');await page.wait_for_timeout(150)
  await check('Responsive editor has no horizontal document overflow', 'document.documentElement.scrollWidth===1280')
  await page.set_viewport_size({'width':1600,'height':1000})
  await page.evaluate('vellum.actions.stressTest()');await page.wait_for_function('vellum.doc.nodes.length===5000 && vellum.renderer.visibleCount===5000',timeout=10000)
  await check('5,000-shape scene renders and remains editable', 'vellum.doc.nodes.length===5000 && vellum.renderer.visibleCount===5000')
  stats=await page.evaluate('({backend:vellum.renderer.backend,instances:vellum.renderer.instanceCount,visibleLayers:vellum.renderer.visibleCount,cpuSubmissionMs:vellum.renderer.cpuMs,drawCalls:vellum.renderer.drawCalls,gpuError:vellum.renderer.gpuError,secureContext:isSecureContext})')
  if errors: raise AssertionError('Browser errors: '+repr(errors))
  results.append({'name':'No uncaught browser errors','passed':True})
  report={'mode':'inline opaque-origin browser' if args.inline else args.url,'passed':len(results),'results':results,'stressScene':stats,'limitations':['GPU execution was not validated in inline mode.','Opaque-origin inline mode cannot validate persistent browser storage.'] if args.inline else []}
  (output/'results.json').write_text(json.dumps(report,indent=2))
  print(json.dumps(report,indent=2))
  await browser.close()

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--inline',action='store_true');parser.add_argument('--url',default='http://localhost:8765/');parser.add_argument('--expect-backend',choices=['WebGPU','Canvas 2D']);parser.add_argument('--output-dir',default=str(ROOT/'test-results'));args=parser.parse_args();asyncio.run(main(args))
