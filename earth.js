"use strict";

// WebGL 1.0으로 직접 그린다. 외부 라이브러리와 네트워크 연결은 필요 없다.
// 순서: 고도 읽기 → 구 정점/법선 생성 → 셰이더 연결 → 매 프레임 회전/조명.
(() => {
    const PI = Math.PI;
    const RAD = PI / 180;
    const EARTH_RADIUS = 6371000;
    const canvas = document.getElementById("gl-canvas");
    const gl = canvas.getContext("webgl", { antialias: true, preserveDrawingBuffer: true });
    const $ = id => document.getElementById(id);
    const data = window.EARTH_DATA;
    function fail(message) { $("error").hidden = false; $("error").textContent = message; }
    if (!gl) { fail("WebGL을 사용할 수 없습니다. Chrome 또는 Edge의 그래픽 가속 설정을 확인해 주세요."); return; }
    if (!data || data.elevations.length !== data.width * data.height) {
        fail("고도 자료가 없습니다. data/elevation.js가 index.html과 함께 있어야 합니다."); return;
    }

    const state = { angle: -125 * RAD, paused: false, speed: 8, tilt: 23.4,
        displacement: true, height: 35, bump: true, bumpStrength: 80,
        axis: true, lightAngle: 35, brightness: 1.2, yaw: 0, pitch: 0.22, distance: 4.4 };

    // 1. 행렬/벡터: 열 우선 저장, 행렬 곱 A*B는 B 변환이 먼저 적용된다.
    function normalize(v) { const l = Math.hypot(...v) || 1; return v.map(x => x / l); }
    function cross(a,b) { return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]; }
    function dot(a,b) { return a.reduce((s,x,i) => s+x*b[i],0); }
    function multiply(a,b) {
        const r = new Float32Array(16);
        for(let col=0;col<4;col++) for(let row=0;row<4;row++)
            for(let k=0;k<4;k++) r[col*4+row] += a[k*4+row]*b[col*4+k];
        return r;
    }
    function rotateY(a) { const c=Math.cos(a),s=Math.sin(a); return new Float32Array([c,0,-s,0, 0,1,0,0, s,0,c,0, 0,0,0,1]); }
    function rotateZ(a) { const c=Math.cos(a),s=Math.sin(a); return new Float32Array([c,s,0,0, -s,c,0,0, 0,0,1,0, 0,0,0,1]); }
    function perspective(aspect) {
        const f=1/Math.tan(42*RAD/2),near=0.1,far=30;
        return new Float32Array([f/aspect,0,0,0, 0,f,0,0, 0,0,(far+near)/(near-far),-1, 0,0,2*far*near/(near-far),0]);
    }
    function lookAt(eye) {
        const z=normalize(eye),x=normalize(cross([0,1,0],z)),y=cross(z,x);
        return new Float32Array([x[0],y[0],z[0],0,x[1],y[1],z[1],0,x[2],y[2],z[2],0,-dot(x,eye),-dot(y,eye),-dot(z,eye),1]);
    }

    // 2. 위경도 격자에서 실제 고도를 양선형 보간한다. u=경도, v=위도.
    function heightAt(u,v) {
        u=((u%1)+1)%1; v=Math.max(0,Math.min(1,v));
        const x=u*data.width,y=v*(data.height-1);
        const x0=Math.floor(x)%data.width,x1=(x0+1)%data.width;
        const y0=Math.floor(y),y1=Math.min(y0+1,data.height-1),tx=x-Math.floor(x),ty=y-y0;
        const h=(row,col)=>data.elevations[row*data.width+col];
        return (h(y0,x0)*(1-tx)+h(y0,x1)*tx)*(1-ty)+(h(y1,x0)*(1-tx)+h(y1,x1)*tx)*ty;
    }
    function direction(u,v) {
        const lon=(u*360-180)*RAD,lat=(v*180-90)*RAD;
        return [Math.cos(lat)*Math.cos(lon),Math.sin(lat),-Math.cos(lat)*Math.sin(lon)];
    }
    function displacedPoint(u,v,scale) {
        const radius=1+Math.max(heightAt(u,v),0)*scale/EARTH_RADIUS;
        return direction(u,v).map(x=>x*radius);
    }
    // 정점 변형만 켜도 올바른 조명이 나오도록 변형된 표면의 법선을 계산한다.
    function surfaceNormal(u,v,scale) {
        if(v<0.0001 || v>0.9999) return direction(u,v);
        const e=0.0003;
        const left=displacedPoint(u-e,v,scale),right=displacedPoint(u+e,v,scale);
        const down=displacedPoint(u,v-e,scale),up=displacedPoint(u,v+e,scale);
        return normalize(cross(right.map((x,i)=>x-left[i]),up.map((x,i)=>x-down[i])));
    }

    // 3. GLSL. 범프 매핑은 높이 맵을 단편마다 읽어 법선 방향을 계산한다.
    const vertexSource = `
        attribute vec3 aPosition;
        attribute vec3 aNormal;
        attribute vec2 aUV;
        uniform mat4 uModel, uViewProjection;
        varying vec3 vNormal;
        varying vec2 vUV;
        void main() {
            vUV = aUV;
            vNormal = mat3(uModel) * aNormal;
            gl_Position = uViewProjection * uModel * vec4(aPosition, 1.0);
        }`;
    const fragmentSource = `
        precision highp float;
        uniform sampler2D uHeightMap;
        uniform vec2 uMapSize;
        uniform mat4 uModel;
        uniform vec3 uLight;
        uniform float uBrightness, uBumpStrength, uGeometryScale;
        uniform bool uBump;
        varying vec3 vNormal;
        varying vec2 vUV;
        const float PI = 3.14159265359;
        const float R = 6371000.0;

        float elevation(vec2 uv) {
            // 데이터의 첫 행은 남극. 경도 180도 열은 -180도 열의 복사본이다.
            uv = vec2(fract(uv.x), clamp(uv.y, 0.0, 1.0));
            vec2 t = (uv * (uMapSize - 1.0) + 0.5) / uMapSize;
            vec2 rg = texture2D(uHeightMap, t).rg;
            return (rg.r * 65280.0 + rg.g * 255.0) / 65535.0 * 20000.0 - 11000.0;
        }
        float land(vec2 uv) { return max(elevation(uv), 0.0); }

        vec3 terrainNormal() {
            float lon = (vUV.x * 2.0 - 1.0) * PI;
            float lat = (vUV.y - 0.5) * PI;
            vec3 n = vec3(cos(lat)*cos(lon), sin(lat), -cos(lat)*sin(lon));
            vec3 east = vec3(-sin(lon), 0.0, -cos(lon));
            vec3 north = vec3(-sin(lat)*cos(lon), cos(lat), sin(lat)*sin(lon));
            vec2 d = 0.5 / (uMapSize - 1.0);
            float eastDistance = 2.0*d.x*2.0*PI*R*max(cos(lat), 0.06);
            float northDistance = 2.0*d.y*PI*R;
            float slopeEast = (land(vUV+vec2(d.x,0.0))-land(vUV-vec2(d.x,0.0))) / eastDistance;
            float slopeNorth = (land(vUV+vec2(0.0,d.y))-land(vUV-vec2(0.0,d.y))) / northDistance;
            // 극점 근처의 불안정한 기울기를 완만하게 줄인다.
            float polarFade = smoothstep(0.015, 0.07, cos(lat));
            // 같은 고도를 두 번 더하지 않고 최종 법선을 한 번 계산한다.
            float strength = max(uGeometryScale, uBumpStrength);
            float radius = 1.0 + land(vUV)*uGeometryScale/R;
            return normalize(mat3(uModel) * normalize(n - polarFade*strength/radius*(slopeEast*east+slopeNorth*north)));
        }
        vec3 terrainColor(float h) {
            if(h < 0.0) return mix(vec3(0.025,0.10,0.23), vec3(0.10,0.32,0.49), clamp((h+7000.0)/7000.0,0.0,1.0));
            if(h < 800.0) return mix(vec3(0.13,0.39,0.25),vec3(0.39,0.52,0.29),h/800.0);
            if(h < 2500.0) return mix(vec3(0.39,0.52,0.29),vec3(0.58,0.43,0.27),(h-800.0)/1700.0);
            return mix(vec3(0.58,0.43,0.27),vec3(0.93,0.93,0.85),clamp((h-2500.0)/3000.0,0.0,1.0));
        }
        void main() {
            float h = elevation(vUV);
            vec3 N = uBump ? terrainNormal() : normalize(vNormal);
            float diffuse = max(dot(N, normalize(uLight)), 0.0);
            vec3 color = terrainColor(h) * (0.13 + uBrightness*diffuse);
            gl_FragColor = vec4(color, 1.0);
        }`;
    const lineVertex = `attribute vec3 aPosition; uniform mat4 uMVP; void main(){ gl_Position=uMVP*vec4(aPosition,1.0); }`;
    const lineFragment = `precision mediump float; uniform vec3 uColor; void main(){ gl_FragColor=vec4(uColor,1.0); }`;
    function program(vs,fs) {
        const p=gl.createProgram();
        for(const [type,source] of [[gl.VERTEX_SHADER,vs],[gl.FRAGMENT_SHADER,fs]]) {
            const shader=gl.createShader(type); gl.shaderSource(shader,source); gl.compileShader(shader);
            if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(shader));
            gl.attachShader(p,shader); gl.deleteShader(shader);
        }
        gl.linkProgram(p);
        if(!gl.getProgramParameter(p,gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(p));
        return p;
    }
    let earthProgram,axisProgram;
    try { earthProgram=program(vertexSource,fragmentSource); axisProgram=program(lineVertex,lineFragment); }
    catch(e) { fail("셰이더 오류: " + e.message); return; }
    const uniforms={};
    for(const name of ["uModel","uViewProjection","uHeightMap","uMapSize","uLight","uBrightness","uBumpStrength","uGeometryScale","uBump"])
        uniforms[name]=gl.getUniformLocation(earthProgram,name);
    const attrs={};
    for(const name of ["aPosition","aNormal","aUV"]) attrs[name]=gl.getAttribLocation(earthProgram,name);
    const linePosition=gl.getAttribLocation(axisProgram,"aPosition");
    const lineMVP=gl.getUniformLocation(axisProgram,"uMVP"),lineColor=gl.getUniformLocation(axisProgram,"uColor");
    const vertexBuffer=gl.createBuffer(),indexBuffer=gl.createBuffer(),lineBuffer=gl.createBuffer();
    let indexCount=0;

    // 4. 구의 삼각형 생성. 128*256 격자는 Uint16 인덱스 범위 안에 들어간다.
    function buildSphere() {
        const rows=128,cols=256,vertices=[],indices=[];
        const scale=state.displacement?state.height:0;
        for(let row=0;row<=rows;row++) for(let col=0;col<=cols;col++) {
            const u=col/cols,v=row/rows;
            vertices.push(...displacedPoint(u,v,scale),...surfaceNormal(u,v,scale),u,v);
        }
        for(let row=0;row<rows;row++) for(let col=0;col<cols;col++) {
            const a=row*(cols+1)+col,b=a+1,c=a+cols+1,d=c+1;
            if(row>0) indices.push(a,b,c);
            if(row<rows-1) indices.push(b,d,c);
        }
        gl.bindBuffer(gl.ARRAY_BUFFER,vertexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(vertices),gl.STATIC_DRAW);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,indexBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array(indices),gl.STATIC_DRAW);
        indexCount=indices.length;
    }

    // 실제 고도 -11000~9000 m를 RG 두 채널에 저장한다(약 0.305 m 간격).
    const texture=gl.createTexture(),mapWidth=data.width+1;
    const pixels=new Uint8Array(mapWidth*data.height*4);
    for(let row=0;row<data.height;row++) for(let col=0;col<mapWidth;col++) {
        const h=data.elevations[row*data.width+(col%data.width)];
        const value=Math.round(Math.max(0,Math.min(1,(h+11000)/20000))*65535);
        const i=(row*mapWidth+col)*4;
        pixels[i]=value>>8; pixels[i+1]=value&255; pixels[i+3]=255;
    }
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,texture);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,mapWidth,data.height,0,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.enable(gl.DEPTH_TEST); gl.enable(gl.CULL_FACE); gl.clearColor(0.025,0.045,0.07,1);
    buildSphere();

    // 5. 회전/광원/카메라. 광원은 월드 공간에 고정하고 지구와 함께 돌리지 않는다.
    function drawLines(vp,model) {
        gl.useProgram(axisProgram);
        gl.uniformMatrix4fv(lineMVP,false,multiply(vp,model));
        gl.bindBuffer(gl.ARRAY_BUFFER,lineBuffer);
        gl.enableVertexAttribArray(linePosition);
        gl.vertexAttribPointer(linePosition,3,gl.FLOAT,false,0,0);
        gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([0,-1.42,0,0,1.42,0]),gl.DYNAMIC_DRAW);
        gl.uniform3f(lineColor,0.94,0.70,0.39); gl.drawArrays(gl.LINES,0,2);
        const ring=[];
        for(let i=0;i<=180;i++) {
            const u=i/180, r=1.006+Math.max(heightAt(u,0.5),0)*(state.displacement?state.height:0)/EARTH_RADIUS;
            ring.push(...direction(u,0.5).map(x=>x*r));
        }
        gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(ring),gl.DYNAMIC_DRAW);
        gl.uniform3f(lineColor,0.38,0.67,0.65); gl.drawArrays(gl.LINE_STRIP,0,ring.length/3);
        const m=multiply(vp,model),p=[0,1.42,0,1],q=[0,0,0,0];
        for(let row=0;row<4;row++) for(let col=0;col<4;col++) q[row]+=m[col*4+row]*p[col];
        $("north-label").style.left=((q[0]/q[3]*0.5+0.5)*canvas.clientWidth+8)+"px";
        $("north-label").style.top=((-q[1]/q[3]*0.5+0.5)*canvas.clientHeight-6)+"px";
    }
    function render() {
        const dpr=Math.min(window.devicePixelRatio||1,2);
        const w=Math.max(1,Math.round(canvas.clientWidth*dpr)),h=Math.max(1,Math.round(canvas.clientHeight*dpr));
        if(canvas.width!==w||canvas.height!==h) { canvas.width=w; canvas.height=h; }
        gl.viewport(0,0,w,h); gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
        // 좁은 화면에서도 처음에는 구와 자전축이 화면 안에 들어오도록 한다.
        const distance=state.distance/Math.min(w/h,1);
        const eye=[distance*Math.cos(state.pitch)*Math.sin(state.yaw),distance*Math.sin(state.pitch),distance*Math.cos(state.pitch)*Math.cos(state.yaw)];
        const vp=multiply(perspective(w/h),lookAt(eye));
        const model=multiply(rotateZ(-state.tilt*RAD),rotateY(state.angle));
        gl.useProgram(earthProgram);
        gl.bindBuffer(gl.ARRAY_BUFFER,vertexBuffer);
        for(const [name,size,offset] of [["aPosition",3,0],["aNormal",3,12],["aUV",2,24]]) {
            gl.enableVertexAttribArray(attrs[name]); gl.vertexAttribPointer(attrs[name],size,gl.FLOAT,false,32,offset);
        }
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,indexBuffer);
        gl.uniformMatrix4fv(uniforms.uModel,false,model); gl.uniformMatrix4fv(uniforms.uViewProjection,false,vp);
        gl.uniform1i(uniforms.uHeightMap,0); gl.uniform2f(uniforms.uMapSize,mapWidth,data.height);
        gl.uniform3fv(uniforms.uLight,normalize([Math.sin(state.lightAngle*RAD),0.38,Math.cos(state.lightAngle*RAD)]));
        gl.uniform1f(uniforms.uBrightness,state.brightness);
        gl.uniform1i(uniforms.uBump,state.bump?1:0);
        gl.uniform1f(uniforms.uBumpStrength,state.bumpStrength);
        gl.uniform1f(uniforms.uGeometryScale,state.displacement?state.height:0);
        gl.drawElements(gl.TRIANGLES,indexCount,gl.UNSIGNED_SHORT,0);
        $("north-label").hidden=!state.axis;
        if(state.axis) drawLines(vp,model);
        $("angle-value").textContent="자전 "+Math.round(((state.angle/RAD)%360+360)%360)+"°";
    }

    // 6. 입력. 고도 배율이 바뀔 때만 메시를 다시 만들고 나머지는 uniform만 바꾼다.
    let rebuildPending=false;
    function requestRebuild() { if(!rebuildPending) { rebuildPending=true; requestAnimationFrame(()=>{ buildSphere();rebuildPending=false; }); } }
    for(const [id,key,suffix] of [["height","height","배"],["bump-strength","bumpStrength","배"],["speed","speed","°/초"],["tilt","tilt","°"],["light-angle","lightAngle","°"],["brightness","brightness",""]]) {
        $(id).addEventListener("input",()=>{
            state[key]=Number($(id).value); $(id+"-value").textContent=state[key]+suffix;
            if(key==="height") requestRebuild();
        });
    }
    for(const key of ["displacement","bump","axis"]) $(key).addEventListener("change",()=>{
        state[key]=$(key).checked; if(key==="displacement") requestRebuild();
    });
    $("pause").addEventListener("click",()=>{ state.paused=!state.paused; $("pause").textContent=state.paused?"자전 재생":"자전 일시정지"; });
    $("reset").addEventListener("click",()=>location.reload());
    let drag=null;
    canvas.addEventListener("pointerdown",e=>{ drag={x:e.clientX,y:e.clientY}; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener("pointermove",e=>{
        if(!drag)return;
        state.yaw-=(e.clientX-drag.x)*0.007;
        state.pitch=Math.max(-1.35,Math.min(1.35,state.pitch+(e.clientY-drag.y)*0.007));
        drag={x:e.clientX,y:e.clientY};
    });
    for(const event of ["pointerup","pointercancel","lostpointercapture"]) canvas.addEventListener(event,()=>drag=null);
    canvas.addEventListener("wheel",e=>{ e.preventDefault(); state.distance=Math.max(2.05,Math.min(6,state.distance*Math.exp(e.deltaY*0.001))); },{passive:false});
    canvas.addEventListener("keydown",e=>{
        if(!["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","+","-"].includes(e.key))return;
        e.preventDefault();
        if(e.key==="ArrowLeft")state.yaw-=0.1; if(e.key==="ArrowRight")state.yaw+=0.1;
        if(e.key==="ArrowUp")state.pitch=Math.min(1.35,state.pitch+0.1);
        if(e.key==="ArrowDown")state.pitch=Math.max(-1.35,state.pitch-0.1);
        if(e.key==="+")state.distance=Math.max(2.05,state.distance-0.15);
        if(e.key==="-")state.distance=Math.min(6,state.distance+0.15);
    });
    $("data-info").textContent=`ETOPO1 / 위경도 ${data.stepDegrees}° 간격 / ${data.elevations.length.toLocaleString()}개 표본. 작은 섬과 세밀한 지형은 생략될 수 있습니다.`;
    let previous=null,stopped=false;
    canvas.addEventListener("webglcontextlost",e=>{ e.preventDefault();stopped=true;fail("그래픽 연결이 끊겼습니다. 페이지를 새로고침해 주세요."); });
    function frame(time) {
        if(stopped)return;
        const dt=previous===null?0:Math.min((time-previous)/1000,0.1); previous=time;
        if(!state.paused)state.angle=(state.angle+state.speed*RAD*dt)%(2*PI);
        render(); requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    // 읽기 전용 검증 정보: 실행 결과를 콘솔에서 확인할 때 사용한다.
    window.earthDebug={state,heightAt,displacedPoint,surfaceNormal,render,
        get triangleCount(){return indexCount/3;}, get glError(){return gl.getError();}};
})();
