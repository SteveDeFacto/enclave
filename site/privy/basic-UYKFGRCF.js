import{a as ai}from"./chunk-RX72V2DT.js";import{c as fo,h as go,i as He,j as pe}from"./chunk-ODZ3XUE4.js";import{a as u,b as h,c as $,d as bo,e as Ot,f as yo}from"./chunk-2ACFQBC5.js";import{A as T,B as z,C as J,D as p,l as ct,o as c,p as he,s as Nt,t as wo,u as m,w as C}from"./chunk-XM6CVL7T.js";import{A as V,B as W,C as v,D as f,E as Ve,F as U,K as x,P as ne,Q as at,a as ke,e as nt,p as st,q as mo,r as w,t as N,u as de,x as lt,z as Pt}from"./chunk-A3UGMEVQ.js";import"./chunk-3XBTBSJO.js";import"./chunk-VGKAVQRI.js";import"./chunk-JG6YPVA3.js";import"./chunk-TMJMA6BR.js";import"./chunk-JTYV7RXW.js";import{b as _,e as li}from"./chunk-KL2DZ7E2.js";var ko=_((Yl,Lo)=>{Lo.exports=function(){return typeof Promise=="function"&&Promise.prototype&&Promise.prototype.then}});var me=_(Re=>{var Mt,fi=[0,26,44,70,100,134,172,196,242,292,346,404,466,532,581,655,733,815,901,991,1085,1156,1258,1364,1474,1588,1706,1828,1921,2051,2185,2323,2465,2611,2761,2876,3034,3196,3362,3532,3706];Re.getSymbolSize=function(e){if(!e)throw new Error('"version" cannot be null or undefined');if(e<1||e>40)throw new Error('"version" should be in range from 1 to 40');return e*4+17};Re.getSymbolTotalCodewords=function(e){return fi[e]};Re.getBCHDigit=function(t){let e=0;for(;t!==0;)e++,t>>>=1;return e};Re.setToSJISFunction=function(e){if(typeof e!="function")throw new Error('"toSJISFunc" is not a valid function.');Mt=e};Re.isKanjiModeEnabled=function(){return typeof Mt<"u"};Re.toSJIS=function(e){return Mt(e)}});var mt=_(H=>{H.L={bit:1};H.M={bit:0};H.Q={bit:3};H.H={bit:2};function gi(t){if(typeof t!="string")throw new Error("Param is not a string");switch(t.toLowerCase()){case"l":case"low":return H.L;case"m":case"medium":return H.M;case"q":case"quartile":return H.Q;case"h":case"high":return H.H;default:throw new Error("Unknown EC Level: "+t)}}H.isValid=function(e){return e&&typeof e.bit<"u"&&e.bit>=0&&e.bit<4};H.from=function(e,o){if(H.isValid(e))return e;try{return gi(e)}catch{return o}}});var No=_((Zl,Po)=>{function Bo(){this.buffer=[],this.length=0}Bo.prototype={get:function(t){let e=Math.floor(t/8);return(this.buffer[e]>>>7-t%8&1)===1},put:function(t,e){for(let o=0;o<e;o++)this.putBit((t>>>e-o-1&1)===1)},getLengthInBits:function(){return this.length},putBit:function(t){let e=Math.floor(this.length/8);this.buffer.length<=e&&this.buffer.push(0),t&&(this.buffer[e]|=128>>>this.length%8),this.length++}};Po.exports=Bo});var Do=_((ea,Oo)=>{function Qe(t){if(!t||t<1)throw new Error("BitMatrix size must be defined and greater than 0");this.size=t,this.data=new Uint8Array(t*t),this.reservedBit=new Uint8Array(t*t)}Qe.prototype.set=function(t,e,o,i){let n=t*this.size+e;this.data[n]=o,i&&(this.reservedBit[n]=!0)};Qe.prototype.get=function(t,e){return this.data[t*this.size+e]};Qe.prototype.xor=function(t,e,o){this.data[t*this.size+e]^=o};Qe.prototype.isReserved=function(t,e){return this.reservedBit[t*this.size+e]};Oo.exports=Qe});var Mo=_(ft=>{var wi=me().getSymbolSize;ft.getRowColCoords=function(e){if(e===1)return[];let o=Math.floor(e/7)+2,i=wi(e),n=i===145?26:Math.ceil((i-13)/(2*o-2))*2,r=[i-7];for(let s=1;s<o-1;s++)r[s]=r[s-1]-n;return r.push(6),r.reverse()};ft.getPositions=function(e){let o=[],i=ft.getRowColCoords(e),n=i.length;for(let r=0;r<n;r++)for(let s=0;s<n;s++)r===0&&s===0||r===0&&s===n-1||r===n-1&&s===0||o.push([i[r],i[s]]);return o}});var jo=_(zo=>{var bi=me().getSymbolSize,Uo=7;zo.getPositions=function(e){let o=bi(e);return[[0,0],[o-Uo,0],[0,o-Uo]]}});var qo=_(A=>{A.Patterns={PATTERN000:0,PATTERN001:1,PATTERN010:2,PATTERN011:3,PATTERN100:4,PATTERN101:5,PATTERN110:6,PATTERN111:7};var Se={N1:3,N2:3,N3:40,N4:10};A.isValid=function(e){return e!=null&&e!==""&&!isNaN(e)&&e>=0&&e<=7};A.from=function(e){return A.isValid(e)?parseInt(e,10):void 0};A.getPenaltyN1=function(e){let o=e.size,i=0,n=0,r=0,s=null,l=null;for(let a=0;a<o;a++){n=r=0,s=l=null;for(let d=0;d<o;d++){let b=e.get(a,d);b===s?n++:(n>=5&&(i+=Se.N1+(n-5)),s=b,n=1),b=e.get(d,a),b===l?r++:(r>=5&&(i+=Se.N1+(r-5)),l=b,r=1)}n>=5&&(i+=Se.N1+(n-5)),r>=5&&(i+=Se.N1+(r-5))}return i};A.getPenaltyN2=function(e){let o=e.size,i=0;for(let n=0;n<o-1;n++)for(let r=0;r<o-1;r++){let s=e.get(n,r)+e.get(n,r+1)+e.get(n+1,r)+e.get(n+1,r+1);(s===4||s===0)&&i++}return i*Se.N2};A.getPenaltyN3=function(e){let o=e.size,i=0,n=0,r=0;for(let s=0;s<o;s++){n=r=0;for(let l=0;l<o;l++)n=n<<1&2047|e.get(s,l),l>=10&&(n===1488||n===93)&&i++,r=r<<1&2047|e.get(l,s),l>=10&&(r===1488||r===93)&&i++}return i*Se.N3};A.getPenaltyN4=function(e){let o=0,i=e.data.length;for(let r=0;r<i;r++)o+=e.data[r];return Math.abs(Math.ceil(o*100/i/5)-10)*Se.N4};function yi(t,e,o){switch(t){case A.Patterns.PATTERN000:return(e+o)%2===0;case A.Patterns.PATTERN001:return e%2===0;case A.Patterns.PATTERN010:return o%3===0;case A.Patterns.PATTERN011:return(e+o)%3===0;case A.Patterns.PATTERN100:return(Math.floor(e/2)+Math.floor(o/3))%2===0;case A.Patterns.PATTERN101:return e*o%2+e*o%3===0;case A.Patterns.PATTERN110:return(e*o%2+e*o%3)%2===0;case A.Patterns.PATTERN111:return(e*o%3+(e+o)%2)%2===0;default:throw new Error("bad maskPattern:"+t)}}A.applyMask=function(e,o){let i=o.size;for(let n=0;n<i;n++)for(let r=0;r<i;r++)o.isReserved(r,n)||o.xor(r,n,yi(e,r,n))};A.getBestMask=function(e,o){let i=Object.keys(A.Patterns).length,n=0,r=1/0;for(let s=0;s<i;s++){o(s),A.applyMask(s,e);let l=A.getPenaltyN1(e)+A.getPenaltyN2(e)+A.getPenaltyN3(e)+A.getPenaltyN4(e);A.applyMask(s,e),l<r&&(r=l,n=s)}return n}});var zt=_(Ut=>{var fe=mt(),gt=[1,1,1,1,1,1,1,1,1,1,2,2,1,2,2,4,1,2,4,4,2,4,4,4,2,4,6,5,2,4,6,6,2,5,8,8,4,5,8,8,4,5,8,11,4,8,10,11,4,9,12,16,4,9,16,16,6,10,12,18,6,10,17,16,6,11,16,19,6,13,18,21,7,14,21,25,8,16,20,25,8,17,23,25,9,17,23,34,9,18,25,30,10,20,27,32,12,21,29,35,12,23,34,37,12,25,34,40,13,26,35,42,14,28,38,45,15,29,40,48,16,31,43,51,17,33,45,54,18,35,48,57,19,37,51,60,19,38,53,63,20,40,56,66,21,43,59,70,22,45,62,74,24,47,65,77,25,49,68,81],wt=[7,10,13,17,10,16,22,28,15,26,36,44,20,36,52,64,26,48,72,88,36,64,96,112,40,72,108,130,48,88,132,156,60,110,160,192,72,130,192,224,80,150,224,264,96,176,260,308,104,198,288,352,120,216,320,384,132,240,360,432,144,280,408,480,168,308,448,532,180,338,504,588,196,364,546,650,224,416,600,700,224,442,644,750,252,476,690,816,270,504,750,900,300,560,810,960,312,588,870,1050,336,644,952,1110,360,700,1020,1200,390,728,1050,1260,420,784,1140,1350,450,812,1200,1440,480,868,1290,1530,510,924,1350,1620,540,980,1440,1710,570,1036,1530,1800,570,1064,1590,1890,600,1120,1680,1980,630,1204,1770,2100,660,1260,1860,2220,720,1316,1950,2310,750,1372,2040,2430];Ut.getBlocksCount=function(e,o){switch(o){case fe.L:return gt[(e-1)*4+0];case fe.M:return gt[(e-1)*4+1];case fe.Q:return gt[(e-1)*4+2];case fe.H:return gt[(e-1)*4+3];default:return}};Ut.getTotalCodewordsCount=function(e,o){switch(o){case fe.L:return wt[(e-1)*4+0];case fe.M:return wt[(e-1)*4+1];case fe.Q:return wt[(e-1)*4+2];case fe.H:return wt[(e-1)*4+3];default:return}}});var Fo=_(yt=>{var Ye=new Uint8Array(512),bt=new Uint8Array(256);(function(){let e=1;for(let o=0;o<255;o++)Ye[o]=e,bt[e]=o,e<<=1,e&256&&(e^=285);for(let o=255;o<512;o++)Ye[o]=Ye[o-255]})();yt.log=function(e){if(e<1)throw new Error("log("+e+")");return bt[e]};yt.exp=function(e){return Ye[e]};yt.mul=function(e,o){return e===0||o===0?0:Ye[bt[e]+bt[o]]}});var Vo=_(Je=>{var jt=Fo();Je.mul=function(e,o){let i=new Uint8Array(e.length+o.length-1);for(let n=0;n<e.length;n++)for(let r=0;r<o.length;r++)i[n+r]^=jt.mul(e[n],o[r]);return i};Je.mod=function(e,o){let i=new Uint8Array(e);for(;i.length-o.length>=0;){let n=i[0];for(let s=0;s<o.length;s++)i[s]^=jt.mul(o[s],n);let r=0;for(;r<i.length&&i[r]===0;)r++;i=i.slice(r)}return i};Je.generateECPolynomial=function(e){let o=new Uint8Array([1]);for(let i=0;i<e;i++)o=Je.mul(o,new Uint8Array([1,jt.exp(i)]));return o}});var Go=_((la,Ko)=>{var Ho=Vo();function qt(t){this.genPoly=void 0,this.degree=t,this.degree&&this.initialize(this.degree)}qt.prototype.initialize=function(e){this.degree=e,this.genPoly=Ho.generateECPolynomial(this.degree)};qt.prototype.encode=function(e){if(!this.genPoly)throw new Error("Encoder not initialized");let o=new Uint8Array(e.length+this.degree);o.set(e);let i=Ho.mod(o,this.genPoly),n=this.degree-i.length;if(n>0){let r=new Uint8Array(this.degree);return r.set(i,n),r}return i};Ko.exports=qt});var Ft=_(Qo=>{Qo.isValid=function(e){return!isNaN(e)&&e>=1&&e<=40}});var Vt=_(ae=>{var Yo="[0-9]+",xi="[A-Z $%*+\\-./:]+",Xe="(?:[u3000-u303F]|[u3040-u309F]|[u30A0-u30FF]|[uFF00-uFFEF]|[u4E00-u9FAF]|[u2605-u2606]|[u2190-u2195]|u203B|[u2010u2015u2018u2019u2025u2026u201Cu201Du2225u2260]|[u0391-u0451]|[u00A7u00A8u00B1u00B4u00D7u00F7])+";Xe=Xe.replace(/u/g,"\\u");var Ci="(?:(?![A-Z0-9 $%*+\\-./:]|"+Xe+`)(?:.|[\r
]))+`;ae.KANJI=new RegExp(Xe,"g");ae.BYTE_KANJI=new RegExp("[^A-Z0-9 $%*+\\-./:]+","g");ae.BYTE=new RegExp(Ci,"g");ae.NUMERIC=new RegExp(Yo,"g");ae.ALPHANUMERIC=new RegExp(xi,"g");var vi=new RegExp("^"+Xe+"$"),$i=new RegExp("^"+Yo+"$"),Ei=new RegExp("^[A-Z0-9 $%*+\\-./:]+$");ae.testKanji=function(e){return vi.test(e)};ae.testNumeric=function(e){return $i.test(e)};ae.testAlphanumeric=function(e){return Ei.test(e)}});var ge=_(D=>{var Ri=Ft(),Ht=Vt();D.NUMERIC={id:"Numeric",bit:1,ccBits:[10,12,14]};D.ALPHANUMERIC={id:"Alphanumeric",bit:2,ccBits:[9,11,13]};D.BYTE={id:"Byte",bit:4,ccBits:[8,16,16]};D.KANJI={id:"Kanji",bit:8,ccBits:[8,10,12]};D.MIXED={bit:-1};D.getCharCountIndicator=function(e,o){if(!e.ccBits)throw new Error("Invalid mode: "+e);if(!Ri.isValid(o))throw new Error("Invalid version: "+o);return o>=1&&o<10?e.ccBits[0]:o<27?e.ccBits[1]:e.ccBits[2]};D.getBestModeForData=function(e){return Ht.testNumeric(e)?D.NUMERIC:Ht.testAlphanumeric(e)?D.ALPHANUMERIC:Ht.testKanji(e)?D.KANJI:D.BYTE};D.toString=function(e){if(e&&e.id)return e.id;throw new Error("Invalid mode")};D.isValid=function(e){return e&&e.bit&&e.ccBits};function Si(t){if(typeof t!="string")throw new Error("Param is not a string");switch(t.toLowerCase()){case"numeric":return D.NUMERIC;case"alphanumeric":return D.ALPHANUMERIC;case"kanji":return D.KANJI;case"byte":return D.BYTE;default:throw new Error("Unknown mode: "+t)}}D.from=function(e,o){if(D.isValid(e))return e;try{return Si(e)}catch{return o}}});var tr=_(_e=>{var xt=me(),_i=zt(),Jo=mt(),we=ge(),Kt=Ft(),Zo=7973,Xo=xt.getBCHDigit(Zo);function Ti(t,e,o){for(let i=1;i<=40;i++)if(e<=_e.getCapacity(i,o,t))return i}function er(t,e){return we.getCharCountIndicator(t,e)+4}function Ai(t,e){let o=0;return t.forEach(function(i){let n=er(i.mode,e);o+=n+i.getBitsLength()}),o}function Ii(t,e){for(let o=1;o<=40;o++)if(Ai(t,o)<=_e.getCapacity(o,e,we.MIXED))return o}_e.from=function(e,o){return Kt.isValid(e)?parseInt(e,10):o};_e.getCapacity=function(e,o,i){if(!Kt.isValid(e))throw new Error("Invalid QR Code version");typeof i>"u"&&(i=we.BYTE);let n=xt.getSymbolTotalCodewords(e),r=_i.getTotalCodewordsCount(e,o),s=(n-r)*8;if(i===we.MIXED)return s;let l=s-er(i,e);switch(i){case we.NUMERIC:return Math.floor(l/10*3);case we.ALPHANUMERIC:return Math.floor(l/11*2);case we.KANJI:return Math.floor(l/13);case we.BYTE:default:return Math.floor(l/8)}};_e.getBestVersionForData=function(e,o){let i,n=Jo.from(o,Jo.M);if(Array.isArray(e)){if(e.length>1)return Ii(e,n);if(e.length===0)return 1;i=e[0]}else i=e;return Ti(i.mode,i.getLength(),n)};_e.getEncodedBits=function(e){if(!Kt.isValid(e)||e<7)throw new Error("Invalid QR Code version");let o=e<<12;for(;xt.getBCHDigit(o)-Xo>=0;)o^=Zo<<xt.getBCHDigit(o)-Xo;return e<<12|o}});var nr=_(ir=>{var Gt=me(),rr=1335,Wi=21522,or=Gt.getBCHDigit(rr);ir.getEncodedBits=function(e,o){let i=e.bit<<3|o,n=i<<10;for(;Gt.getBCHDigit(n)-or>=0;)n^=rr<<Gt.getBCHDigit(n)-or;return(i<<10|n)^Wi}});var lr=_((ha,sr)=>{var Li=ge();function Oe(t){this.mode=Li.NUMERIC,this.data=t.toString()}Oe.getBitsLength=function(e){return 10*Math.floor(e/3)+(e%3?e%3*3+1:0)};Oe.prototype.getLength=function(){return this.data.length};Oe.prototype.getBitsLength=function(){return Oe.getBitsLength(this.data.length)};Oe.prototype.write=function(e){let o,i,n;for(o=0;o+3<=this.data.length;o+=3)i=this.data.substr(o,3),n=parseInt(i,10),e.put(n,10);let r=this.data.length-o;r>0&&(i=this.data.substr(o),n=parseInt(i,10),e.put(n,r*3+1))};sr.exports=Oe});var cr=_((ma,ar)=>{var ki=ge(),Qt=["0","1","2","3","4","5","6","7","8","9","A","B","C","D","E","F","G","H","I","J","K","L","M","N","O","P","Q","R","S","T","U","V","W","X","Y","Z"," ","$","%","*","+","-",".","/",":"];function De(t){this.mode=ki.ALPHANUMERIC,this.data=t}De.getBitsLength=function(e){return 11*Math.floor(e/2)+6*(e%2)};De.prototype.getLength=function(){return this.data.length};De.prototype.getBitsLength=function(){return De.getBitsLength(this.data.length)};De.prototype.write=function(e){let o;for(o=0;o+2<=this.data.length;o+=2){let i=Qt.indexOf(this.data[o])*45;i+=Qt.indexOf(this.data[o+1]),e.put(i,11)}this.data.length%2&&e.put(Qt.indexOf(this.data[o]),6)};ar.exports=De});var dr=_((fa,ur)=>{"use strict";ur.exports=function(e){for(var o=[],i=e.length,n=0;n<i;n++){var r=e.charCodeAt(n);if(r>=55296&&r<=56319&&i>n+1){var s=e.charCodeAt(n+1);s>=56320&&s<=57343&&(r=(r-55296)*1024+s-56320+65536,n+=1)}if(r<128){o.push(r);continue}if(r<2048){o.push(r>>6|192),o.push(r&63|128);continue}if(r<55296||r>=57344&&r<65536){o.push(r>>12|224),o.push(r>>6&63|128),o.push(r&63|128);continue}if(r>=65536&&r<=1114111){o.push(r>>18|240),o.push(r>>12&63|128),o.push(r>>6&63|128),o.push(r&63|128);continue}o.push(239,191,189)}return new Uint8Array(o).buffer}});var hr=_((ga,pr)=>{var Bi=dr(),Pi=ge();function Me(t){this.mode=Pi.BYTE,typeof t=="string"&&(t=Bi(t)),this.data=new Uint8Array(t)}Me.getBitsLength=function(e){return e*8};Me.prototype.getLength=function(){return this.data.length};Me.prototype.getBitsLength=function(){return Me.getBitsLength(this.data.length)};Me.prototype.write=function(t){for(let e=0,o=this.data.length;e<o;e++)t.put(this.data[e],8)};pr.exports=Me});var fr=_((wa,mr)=>{var Ni=ge(),Oi=me();function Ue(t){this.mode=Ni.KANJI,this.data=t}Ue.getBitsLength=function(e){return e*13};Ue.prototype.getLength=function(){return this.data.length};Ue.prototype.getBitsLength=function(){return Ue.getBitsLength(this.data.length)};Ue.prototype.write=function(t){let e;for(e=0;e<this.data.length;e++){let o=Oi.toSJIS(this.data[e]);if(o>=33088&&o<=40956)o-=33088;else if(o>=57408&&o<=60351)o-=49472;else throw new Error("Invalid SJIS character: "+this.data[e]+`
Make sure your charset is UTF-8`);o=(o>>>8&255)*192+(o&255),t.put(o,13)}};mr.exports=Ue});var $r=_(ze=>{var E=ge(),br=lr(),yr=cr(),xr=hr(),Cr=fr(),Ze=Vt(),Ct=me(),Di=ai();function gr(t){return unescape(encodeURIComponent(t)).length}function et(t,e,o){let i=[],n;for(;(n=t.exec(o))!==null;)i.push({data:n[0],index:n.index,mode:e,length:n[0].length});return i}function vr(t){let e=et(Ze.NUMERIC,E.NUMERIC,t),o=et(Ze.ALPHANUMERIC,E.ALPHANUMERIC,t),i,n;return Ct.isKanjiModeEnabled()?(i=et(Ze.BYTE,E.BYTE,t),n=et(Ze.KANJI,E.KANJI,t)):(i=et(Ze.BYTE_KANJI,E.BYTE,t),n=[]),e.concat(o,i,n).sort(function(s,l){return s.index-l.index}).map(function(s){return{data:s.data,mode:s.mode,length:s.length}})}function Yt(t,e){switch(e){case E.NUMERIC:return br.getBitsLength(t);case E.ALPHANUMERIC:return yr.getBitsLength(t);case E.KANJI:return Cr.getBitsLength(t);case E.BYTE:return xr.getBitsLength(t)}}function Mi(t){return t.reduce(function(e,o){let i=e.length-1>=0?e[e.length-1]:null;return i&&i.mode===o.mode?(e[e.length-1].data+=o.data,e):(e.push(o),e)},[])}function Ui(t){let e=[];for(let o=0;o<t.length;o++){let i=t[o];switch(i.mode){case E.NUMERIC:e.push([i,{data:i.data,mode:E.ALPHANUMERIC,length:i.length},{data:i.data,mode:E.BYTE,length:i.length}]);break;case E.ALPHANUMERIC:e.push([i,{data:i.data,mode:E.BYTE,length:i.length}]);break;case E.KANJI:e.push([i,{data:i.data,mode:E.BYTE,length:gr(i.data)}]);break;case E.BYTE:e.push([{data:i.data,mode:E.BYTE,length:gr(i.data)}])}}return e}function zi(t,e){let o={},i={start:{}},n=["start"];for(let r=0;r<t.length;r++){let s=t[r],l=[];for(let a=0;a<s.length;a++){let d=s[a],b=""+r+a;l.push(b),o[b]={node:d,lastCount:0},i[b]={};for(let B=0;B<n.length;B++){let R=n[B];o[R]&&o[R].node.mode===d.mode?(i[R][b]=Yt(o[R].lastCount+d.length,d.mode)-Yt(o[R].lastCount,d.mode),o[R].lastCount+=d.length):(o[R]&&(o[R].lastCount=d.length),i[R][b]=Yt(d.length,d.mode)+4+E.getCharCountIndicator(d.mode,e))}}n=l}for(let r=0;r<n.length;r++)i[n[r]].end=0;return{map:i,table:o}}function wr(t,e){let o,i=E.getBestModeForData(t);if(o=E.from(e,i),o!==E.BYTE&&o.bit<i.bit)throw new Error('"'+t+'" cannot be encoded with mode '+E.toString(o)+`.
 Suggested mode is: `+E.toString(i));switch(o===E.KANJI&&!Ct.isKanjiModeEnabled()&&(o=E.BYTE),o){case E.NUMERIC:return new br(t);case E.ALPHANUMERIC:return new yr(t);case E.KANJI:return new Cr(t);case E.BYTE:return new xr(t)}}ze.fromArray=function(e){return e.reduce(function(o,i){return typeof i=="string"?o.push(wr(i,null)):i.data&&o.push(wr(i.data,i.mode)),o},[])};ze.fromString=function(e,o){let i=vr(e,Ct.isKanjiModeEnabled()),n=Ui(i),r=zi(n,o),s=Di.find_path(r.map,"start","end"),l=[];for(let a=1;a<s.length-1;a++)l.push(r.table[s[a]].node);return ze.fromArray(Mi(l))};ze.rawSplit=function(e){return ze.fromArray(vr(e,Ct.isKanjiModeEnabled()))}});var Rr=_(Er=>{var $t=me(),Jt=mt(),ji=No(),qi=Do(),Fi=Mo(),Vi=jo(),eo=qo(),to=zt(),Hi=Go(),vt=tr(),Ki=nr(),Gi=ge(),Xt=$r();function Qi(t,e){let o=t.size,i=Vi.getPositions(e);for(let n=0;n<i.length;n++){let r=i[n][0],s=i[n][1];for(let l=-1;l<=7;l++)if(!(r+l<=-1||o<=r+l))for(let a=-1;a<=7;a++)s+a<=-1||o<=s+a||(l>=0&&l<=6&&(a===0||a===6)||a>=0&&a<=6&&(l===0||l===6)||l>=2&&l<=4&&a>=2&&a<=4?t.set(r+l,s+a,!0,!0):t.set(r+l,s+a,!1,!0))}}function Yi(t){let e=t.size;for(let o=8;o<e-8;o++){let i=o%2===0;t.set(o,6,i,!0),t.set(6,o,i,!0)}}function Ji(t,e){let o=Fi.getPositions(e);for(let i=0;i<o.length;i++){let n=o[i][0],r=o[i][1];for(let s=-2;s<=2;s++)for(let l=-2;l<=2;l++)s===-2||s===2||l===-2||l===2||s===0&&l===0?t.set(n+s,r+l,!0,!0):t.set(n+s,r+l,!1,!0)}}function Xi(t,e){let o=t.size,i=vt.getEncodedBits(e),n,r,s;for(let l=0;l<18;l++)n=Math.floor(l/3),r=l%3+o-8-3,s=(i>>l&1)===1,t.set(n,r,s,!0),t.set(r,n,s,!0)}function Zt(t,e,o){let i=t.size,n=Ki.getEncodedBits(e,o),r,s;for(r=0;r<15;r++)s=(n>>r&1)===1,r<6?t.set(r,8,s,!0):r<8?t.set(r+1,8,s,!0):t.set(i-15+r,8,s,!0),r<8?t.set(8,i-r-1,s,!0):r<9?t.set(8,15-r-1+1,s,!0):t.set(8,15-r-1,s,!0);t.set(i-8,8,1,!0)}function Zi(t,e){let o=t.size,i=-1,n=o-1,r=7,s=0;for(let l=o-1;l>0;l-=2)for(l===6&&l--;;){for(let a=0;a<2;a++)if(!t.isReserved(n,l-a)){let d=!1;s<e.length&&(d=(e[s]>>>r&1)===1),t.set(n,l-a,d),r--,r===-1&&(s++,r=7)}if(n+=i,n<0||o<=n){n-=i,i=-i;break}}}function en(t,e,o){let i=new ji;o.forEach(function(a){i.put(a.mode.bit,4),i.put(a.getLength(),Gi.getCharCountIndicator(a.mode,t)),a.write(i)});let n=$t.getSymbolTotalCodewords(t),r=to.getTotalCodewordsCount(t,e),s=(n-r)*8;for(i.getLengthInBits()+4<=s&&i.put(0,4);i.getLengthInBits()%8!==0;)i.putBit(0);let l=(s-i.getLengthInBits())/8;for(let a=0;a<l;a++)i.put(a%2?17:236,8);return tn(i,t,e)}function tn(t,e,o){let i=$t.getSymbolTotalCodewords(e),n=to.getTotalCodewordsCount(e,o),r=i-n,s=to.getBlocksCount(e,o),l=i%s,a=s-l,d=Math.floor(i/s),b=Math.floor(r/s),B=b+1,R=d-b,j=new Hi(R),L=0,y=new Array(s),g=new Array(s),I=0,S=new Uint8Array(t.buffer);for(let Le=0;Le<s;Le++){let Bt=Le<a?b:B;y[Le]=S.slice(L,L+Bt),g[Le]=j.encode(y[Le]),L+=Bt,I=Math.max(I,Bt)}let M=new Uint8Array(i),P=0,O,ie;for(O=0;O<I;O++)for(ie=0;ie<s;ie++)O<y[ie].length&&(M[P++]=y[ie][O]);for(O=0;O<R;O++)for(ie=0;ie<s;ie++)M[P++]=g[ie][O];return M}function on(t,e,o,i){let n;if(Array.isArray(t))n=Xt.fromArray(t);else if(typeof t=="string"){let d=e;if(!d){let b=Xt.rawSplit(t);d=vt.getBestVersionForData(b,o)}n=Xt.fromString(t,d||40)}else throw new Error("Invalid data");let r=vt.getBestVersionForData(n,o);if(!r)throw new Error("The amount of data is too big to be stored in a QR Code");if(!e)e=r;else if(e<r)throw new Error(`
The chosen QR Code version cannot contain this amount of data.
Minimum version required to store current data is: `+r+`.
`);let s=en(e,o,n),l=$t.getSymbolSize(e),a=new qi(l);return Qi(a,e),Yi(a),Ji(a,e),Zt(a,o,0),e>=7&&Xi(a,e),Zi(a,s),isNaN(i)&&(i=eo.getBestMask(a,Zt.bind(null,a,o))),eo.applyMask(i,a),Zt(a,o,i),{modules:a,version:e,errorCorrectionLevel:o,maskPattern:i,segments:n}}Er.create=function(e,o){if(typeof e>"u"||e==="")throw new Error("No input text");let i=Jt.M,n,r;return typeof o<"u"&&(i=Jt.from(o.errorCorrectionLevel,Jt.M),n=vt.from(o.version),r=eo.from(o.maskPattern),o.toSJISFunc&&$t.setToSJISFunction(o.toSJISFunc)),on(e,n,i,r)}});var oo=_(Te=>{function Sr(t){if(typeof t=="number"&&(t=t.toString()),typeof t!="string")throw new Error("Color should be defined as hex string");let e=t.slice().replace("#","").split("");if(e.length<3||e.length===5||e.length>8)throw new Error("Invalid hex color: "+t);(e.length===3||e.length===4)&&(e=Array.prototype.concat.apply([],e.map(function(i){return[i,i]}))),e.length===6&&e.push("F","F");let o=parseInt(e.join(""),16);return{r:o>>24&255,g:o>>16&255,b:o>>8&255,a:o&255,hex:"#"+e.slice(0,6).join("")}}Te.getOptions=function(e){e||(e={}),e.color||(e.color={});let o=typeof e.margin>"u"||e.margin===null||e.margin<0?4:e.margin,i=e.width&&e.width>=21?e.width:void 0,n=e.scale||4;return{width:i,scale:i?4:n,margin:o,color:{dark:Sr(e.color.dark||"#000000ff"),light:Sr(e.color.light||"#ffffffff")},type:e.type,rendererOpts:e.rendererOpts||{}}};Te.getScale=function(e,o){return o.width&&o.width>=e+o.margin*2?o.width/(e+o.margin*2):o.scale};Te.getImageWidth=function(e,o){let i=Te.getScale(e,o);return Math.floor((e+o.margin*2)*i)};Te.qrToImageData=function(e,o,i){let n=o.modules.size,r=o.modules.data,s=Te.getScale(n,i),l=Math.floor((n+i.margin*2)*s),a=i.margin*s,d=[i.color.light,i.color.dark];for(let b=0;b<l;b++)for(let B=0;B<l;B++){let R=(b*l+B)*4,j=i.color.light;if(b>=a&&B>=a&&b<l-a&&B<l-a){let L=Math.floor((b-a)/s),y=Math.floor((B-a)/s);j=d[r[L*n+y]?1:0]}e[R++]=j.r,e[R++]=j.g,e[R++]=j.b,e[R]=j.a}}});var _r=_(Et=>{var ro=oo();function rn(t,e,o){t.clearRect(0,0,e.width,e.height),e.style||(e.style={}),e.height=o,e.width=o,e.style.height=o+"px",e.style.width=o+"px"}function nn(){try{return document.createElement("canvas")}catch{throw new Error("You need to specify a canvas element")}}Et.render=function(e,o,i){let n=i,r=o;typeof n>"u"&&(!o||!o.getContext)&&(n=o,o=void 0),o||(r=nn()),n=ro.getOptions(n);let s=ro.getImageWidth(e.modules.size,n),l=r.getContext("2d"),a=l.createImageData(s,s);return ro.qrToImageData(a.data,e,n),rn(l,r,s),l.putImageData(a,0,0),r};Et.renderToDataURL=function(e,o,i){let n=i;typeof n>"u"&&(!o||!o.getContext)&&(n=o,o=void 0),n||(n={});let r=Et.render(e,o,n),s=n.type||"image/png",l=n.rendererOpts||{};return r.toDataURL(s,l.quality)}});var Ir=_(Ar=>{var sn=oo();function Tr(t,e){let o=t.a/255,i=e+'="'+t.hex+'"';return o<1?i+" "+e+'-opacity="'+o.toFixed(2).slice(1)+'"':i}function io(t,e,o){let i=t+e;return typeof o<"u"&&(i+=" "+o),i}function ln(t,e,o){let i="",n=0,r=!1,s=0;for(let l=0;l<t.length;l++){let a=Math.floor(l%e),d=Math.floor(l/e);!a&&!r&&(r=!0),t[l]?(s++,l>0&&a>0&&t[l-1]||(i+=r?io("M",a+o,.5+d+o):io("m",n,0),n=0,r=!1),a+1<e&&t[l+1]||(i+=io("h",s),s=0)):n++}return i}Ar.render=function(e,o,i){let n=sn.getOptions(o),r=e.modules.size,s=e.modules.data,l=r+n.margin*2,a=n.color.light.a?"<path "+Tr(n.color.light,"fill")+' d="M0 0h'+l+"v"+l+'H0z"/>':"",d="<path "+Tr(n.color.dark,"stroke")+' d="'+ln(s,r,n.margin)+'"/>',b='viewBox="0 0 '+l+" "+l+'"',R='<svg xmlns="http://www.w3.org/2000/svg" '+(n.width?'width="'+n.width+'" height="'+n.width+'" ':"")+b+' shape-rendering="crispEdges">'+a+d+`</svg>
`;return typeof i=="function"&&i(null,R),R}});var Lr=_(tt=>{var an=ko(),no=Rr(),Wr=_r(),cn=Ir();function so(t,e,o,i,n){let r=[].slice.call(arguments,1),s=r.length,l=typeof r[s-1]=="function";if(!l&&!an())throw new Error("Callback required as last argument");if(l){if(s<2)throw new Error("Too few arguments provided");s===2?(n=o,o=e,e=i=void 0):s===3&&(e.getContext&&typeof n>"u"?(n=i,i=void 0):(n=i,i=o,o=e,e=void 0))}else{if(s<1)throw new Error("Too few arguments provided");return s===1?(o=e,e=i=void 0):s===2&&!e.getContext&&(i=o,o=e,e=void 0),new Promise(function(a,d){try{let b=no.create(o,i);a(t(b,e,i))}catch(b){d(b)}})}try{let a=no.create(o,i);n(null,t(a,e,i))}catch(a){n(a)}}tt.create=no.create;tt.toCanvas=so.bind(null,Wr.render);tt.toDataURL=so.bind(null,Wr.renderToDataURL);tt.toString=so.bind(null,function(t,e,o){return cn.render(t,o)})});var Be=function(t,e,o,i){var n=arguments.length,r=n<3?e:i===null?i=Object.getOwnPropertyDescriptor(e,o):i,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")r=Reflect.decorate(t,e,o,i);else for(var l=t.length-1;l>=0;l--)(s=t[l])&&(r=(n<3?s(r):n>3?s(e,o,r):s(e,o))||r);return n>3&&r&&Object.defineProperty(e,o,r),r},xe=class extends m{constructor(){super(),this.unsubscribe=[],this.tabIdx=void 0,this.connectors=U.state.connectors,this.count=v.state.count,this.filteredCount=v.state.filteredWallets.length,this.isFetchingRecommendedWallets=v.state.isFetchingRecommendedWallets,this.unsubscribe.push(U.subscribeKey("connectors",e=>this.connectors=e),v.subscribeKey("count",e=>this.count=e),v.subscribeKey("filteredWallets",e=>this.filteredCount=e.length),v.subscribeKey("isFetchingRecommendedWallets",e=>this.isFetchingRecommendedWallets=e))}disconnectedCallback(){this.unsubscribe.forEach(e=>e())}render(){let e=this.connectors.find(d=>d.id==="walletConnect"),{allWallets:o}=N.state;if(!e||o==="HIDE"||o==="ONLY_MOBILE"&&!w.isMobile())return null;let i=v.state.featured.length,n=this.count+i,r=n<10?n:Math.floor(n/10)*10,s=this.filteredCount>0?this.filteredCount:r,l=`${s}`;this.filteredCount>0?l=`${this.filteredCount}`:s<n&&(l=`${s}+`);let a=x.hasAnyConnection(ke.CONNECTOR_ID.WALLET_CONNECT);return c`
      <wui-list-wallet
        name="Search Wallet"
        walletIcon="search"
        showAllWallets
        @click=${this.onAllWallets.bind(this)}
        tagLabel=${l}
        tagVariant="info"
        data-testid="all-wallets"
        tabIdx=${$(this.tabIdx)}
        .loading=${this.isFetchingRecommendedWallets}
        ?disabled=${a}
        size="sm"
      ></wui-list-wallet>
    `}onAllWallets(){W.sendEvent({type:"track",event:"CLICK_ALL_WALLETS"}),f.push("AllWallets",{redirectView:f.state.data?.redirectView})}};Be([u()],xe.prototype,"tabIdx",void 0);Be([h()],xe.prototype,"connectors",void 0);Be([h()],xe.prototype,"count",void 0);Be([h()],xe.prototype,"filteredCount",void 0);Be([h()],xe.prototype,"isFetchingRecommendedWallets",void 0);xe=Be([p("w3m-all-wallets-widget")],xe);var xo=C`
  :host {
    margin-top: ${({spacing:t})=>t[1]};
  }
  wui-separator {
    margin: ${({spacing:t})=>t[3]} calc(${({spacing:t})=>t[3]} * -1)
      ${({spacing:t})=>t[2]} calc(${({spacing:t})=>t[3]} * -1);
    width: calc(100% + ${({spacing:t})=>t[3]} * 2);
  }
`;var se=function(t,e,o,i){var n=arguments.length,r=n<3?e:i===null?i=Object.getOwnPropertyDescriptor(e,o):i,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")r=Reflect.decorate(t,e,o,i);else for(var l=t.length-1;l>=0;l--)(s=t[l])&&(r=(n<3?s(r):n>3?s(e,o,r):s(e,o))||r);return n>3&&r&&Object.defineProperty(e,o,r),r},X=class extends m{constructor(){super(),this.unsubscribe=[],this.connectors=U.state.connectors,this.recommended=v.state.recommended,this.featured=v.state.featured,this.explorerWallets=v.state.explorerWallets,this.connections=x.state.connections,this.connectorImages=Pt.state.connectorImages,this.loadingTelegram=!1,this.unsubscribe.push(U.subscribeKey("connectors",e=>this.connectors=e),x.subscribeKey("connections",e=>this.connections=e),Pt.subscribeKey("connectorImages",e=>this.connectorImages=e),v.subscribeKey("recommended",e=>this.recommended=e),v.subscribeKey("featured",e=>this.featured=e),v.subscribeKey("explorerFilteredWallets",e=>{this.explorerWallets=e?.length?e:v.state.explorerWallets}),v.subscribeKey("explorerWallets",e=>{this.explorerWallets?.length||(this.explorerWallets=e)})),w.isTelegram()&&w.isIos()&&(this.loadingTelegram=!x.state.wcUri,this.unsubscribe.push(x.subscribeKey("wcUri",e=>this.loadingTelegram=!e)))}disconnectedCallback(){this.unsubscribe.forEach(e=>e())}render(){return c`
      <wui-flex flexDirection="column" gap="2"> ${this.connectorListTemplate()} </wui-flex>
    `}mapConnectorsToExplorerWallets(e,o){return e.map(i=>{if(i.type==="MULTI_CHAIN"&&i.connectors){let r=i.connectors.map(d=>d.id),s=i.connectors.map(d=>d.name),l=i.connectors.map(d=>d.info?.rdns),a=o?.find(d=>r.includes(d.id)||s.includes(d.name)||d.rdns&&(l.includes(d.rdns)||r.includes(d.rdns)));return i.explorerWallet=a??i.explorerWallet,i}let n=o?.find(r=>r.id===i.id||r.rdns===i.info?.rdns||r.name===i.name);return i.explorerWallet=n??i.explorerWallet,i})}processConnectorsByType(e,o=!0){let i=pe.sortConnectorsByExplorerWallet([...e]);return o?i.filter(pe.showConnector):i}connectorListTemplate(){let e=this.mapConnectorsToExplorerWallets(this.connectors,this.explorerWallets??[]),o=pe.getConnectorsByType(e,this.recommended,this.featured),i=this.processConnectorsByType(o.announced.filter(y=>y.id!=="walletConnect")),n=this.processConnectorsByType(o.injected),r=this.processConnectorsByType(o.multiChain.filter(y=>y.name!=="WalletConnect"),!1),s=o.custom,l=o.recent,a=this.processConnectorsByType(o.external.filter(y=>y.id!==ke.CONNECTOR_ID.COINBASE_SDK)),d=o.recommended,b=o.featured,B=pe.getConnectorTypeOrder({custom:s,recent:l,announced:i,injected:n,multiChain:r,recommended:d,featured:b,external:a}),R=this.connectors.find(y=>y.id==="walletConnect"),j=w.isMobile(),L=[];for(let y of B)switch(y){case"walletConnect":{!j&&R&&L.push({kind:"connector",subtype:"walletConnect",connector:R});break}case"recent":{pe.getFilteredRecentWallets().forEach(I=>L.push({kind:"wallet",subtype:"recent",wallet:I}));break}case"injected":{r.forEach(g=>L.push({kind:"connector",subtype:"multiChain",connector:g})),i.forEach(g=>L.push({kind:"connector",subtype:"announced",connector:g})),n.forEach(g=>L.push({kind:"connector",subtype:"injected",connector:g}));break}case"featured":{b.forEach(g=>L.push({kind:"wallet",subtype:"featured",wallet:g}));break}case"custom":{pe.getFilteredCustomWallets(s??[]).forEach(I=>L.push({kind:"wallet",subtype:"custom",wallet:I}));break}case"external":{a.forEach(g=>L.push({kind:"connector",subtype:"external",connector:g}));break}case"recommended":{pe.getCappedRecommendedWallets(d).forEach(I=>L.push({kind:"wallet",subtype:"recommended",wallet:I}));break}default:console.warn(`Unknown connector type: ${y}`)}return L.map((y,g)=>y.kind==="connector"?this.renderConnector(y,g):this.renderWallet(y,g))}renderConnector(e,o){let i=e.connector,n=V.getConnectorImage(i)||this.connectorImages[i?.imageId??""],s=(this.connections.get(i.chain)??[]).some(B=>fo.isLowerCaseMatch(B.connectorId,i.id)),l,a;e.subtype==="multiChain"?(l="multichain",a="info"):e.subtype==="walletConnect"?(l="qr code",a="accent"):e.subtype==="injected"||e.subtype==="announced"?(l=s?"connected":"installed",a=s?"info":"success"):(l=void 0,a=void 0);let d=x.hasAnyConnection(ke.CONNECTOR_ID.WALLET_CONNECT),b=e.subtype==="walletConnect"||e.subtype==="external"?d:!1;return c`
      <w3m-list-wallet
        displayIndex=${o}
        imageSrc=${$(n)}
        .installed=${!0}
        name=${i.name??"Unknown"}
        .tagVariant=${a}
        tagLabel=${$(l)}
        data-testid=${`wallet-selector-${i.id.toLowerCase()}`}
        size="sm"
        @click=${()=>this.onClickConnector(e)}
        tabIdx=${$(this.tabIdx)}
        ?disabled=${b}
        rdnsId=${$(i.explorerWallet?.rdns||void 0)}
        walletRank=${$(i.explorerWallet?.order)}
      >
      </w3m-list-wallet>
    `}onClickConnector(e){let o=f.state.data?.redirectView;if(e.subtype==="walletConnect"){U.setActiveConnector(e.connector),w.isMobile()?f.push("AllWallets"):f.push("ConnectingWalletConnect",{redirectView:o});return}if(e.subtype==="multiChain"){U.setActiveConnector(e.connector),f.push("ConnectingMultiChain",{redirectView:o});return}if(e.subtype==="injected"){U.setActiveConnector(e.connector),f.push("ConnectingExternal",{connector:e.connector,redirectView:o,wallet:e.connector.explorerWallet});return}if(e.subtype==="announced"){if(e.connector.id==="walletConnect"){w.isMobile()?f.push("AllWallets"):f.push("ConnectingWalletConnect",{redirectView:o});return}f.push("ConnectingExternal",{connector:e.connector,redirectView:o,wallet:e.connector.explorerWallet});return}f.push("ConnectingExternal",{connector:e.connector,redirectView:o})}renderWallet(e,o){let i=e.wallet,n=V.getWalletImage(i),s=x.hasAnyConnection(ke.CONNECTOR_ID.WALLET_CONNECT),l=this.loadingTelegram,a=e.subtype==="recent"?"recent":void 0,d=e.subtype==="recent"?"info":void 0;return c`
      <w3m-list-wallet
        displayIndex=${o}
        imageSrc=${$(n)}
        name=${i.name??"Unknown"}
        @click=${()=>this.onClickWallet(e)}
        size="sm"
        data-testid=${`wallet-selector-${i.id}`}
        tabIdx=${$(this.tabIdx)}
        ?loading=${l}
        ?disabled=${s}
        rdnsId=${$(i.rdns||void 0)}
        walletRank=${$(i.order)}
        tagLabel=${$(a)}
        .tagVariant=${d}
      >
      </w3m-list-wallet>
    `}onClickWallet(e){let o=f.state.data?.redirectView;if(e.subtype==="featured"){U.selectWalletConnector(e.wallet);return}if(e.subtype==="recent"){if(this.loadingTelegram)return;U.selectWalletConnector(e.wallet);return}if(e.subtype==="custom"){if(this.loadingTelegram)return;f.push("ConnectingWalletConnect",{wallet:e.wallet,redirectView:o});return}if(this.loadingTelegram)return;let i=U.getConnector({id:e.wallet.id,rdns:e.wallet.rdns});i?f.push("ConnectingExternal",{connector:i,redirectView:o}):f.push("ConnectingWalletConnect",{wallet:e.wallet,redirectView:o})}};X.styles=xo;se([u({type:Number})],X.prototype,"tabIdx",void 0);se([h()],X.prototype,"connectors",void 0);se([h()],X.prototype,"recommended",void 0);se([h()],X.prototype,"featured",void 0);se([h()],X.prototype,"explorerWallets",void 0);se([h()],X.prototype,"connections",void 0);se([h()],X.prototype,"connectorImages",void 0);se([h()],X.prototype,"loadingTelegram",void 0);X=se([p("w3m-connector-list")],X);var Co=C`
  :host {
    flex: 1;
    height: 100%;
  }

  button {
    width: 100%;
    height: 100%;
    display: inline-flex;
    align-items: center;
    padding: ${({spacing:t})=>t[1]} ${({spacing:t})=>t[2]};
    column-gap: ${({spacing:t})=>t[1]};
    color: ${({tokens:t})=>t.theme.textSecondary};
    border-radius: ${({borderRadius:t})=>t[20]};
    background-color: transparent;
    transition: background-color ${({durations:t})=>t.lg}
      ${({easings:t})=>t["ease-out-power-2"]};
    will-change: background-color;
  }

  /* -- Hover & Active states ----------------------------------------------------------- */
  button[data-active='true'] {
    color: ${({tokens:t})=>t.theme.textPrimary};
    background-color: ${({tokens:t})=>t.theme.foregroundTertiary};
  }

  button:hover:enabled:not([data-active='true']),
  button:active:enabled:not([data-active='true']) {
    wui-text,
    wui-icon {
      color: ${({tokens:t})=>t.theme.textPrimary};
    }
  }
`;var Ke=function(t,e,o,i){var n=arguments.length,r=n<3?e:i===null?i=Object.getOwnPropertyDescriptor(e,o):i,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")r=Reflect.decorate(t,e,o,i);else for(var l=t.length-1;l>=0;l--)(s=t[l])&&(r=(n<3?s(r):n>3?s(e,o,r):s(e,o))||r);return n>3&&r&&Object.defineProperty(e,o,r),r},ci={lg:"lg-regular",md:"md-regular",sm:"sm-regular"},ui={lg:"md",md:"sm",sm:"sm"},Ce=class extends m{constructor(){super(...arguments),this.icon="mobile",this.size="md",this.label="",this.active=!1}render(){return c`
      <button data-active=${this.active}>
        ${this.icon?c`<wui-icon size=${ui[this.size]} name=${this.icon}></wui-icon>`:""}
        <wui-text variant=${ci[this.size]}> ${this.label} </wui-text>
      </button>
    `}};Ce.styles=[T,z,Co];Ke([u()],Ce.prototype,"icon",void 0);Ke([u()],Ce.prototype,"size",void 0);Ke([u()],Ce.prototype,"label",void 0);Ke([u({type:Boolean})],Ce.prototype,"active",void 0);Ce=Ke([p("wui-tab-item")],Ce);var vo=C`
  :host {
    display: inline-flex;
    align-items: center;
    background-color: ${({tokens:t})=>t.theme.foregroundSecondary};
    border-radius: ${({borderRadius:t})=>t[32]};
    padding: ${({spacing:t})=>t["01"]};
    box-sizing: border-box;
  }

  :host([data-size='sm']) {
    height: 26px;
  }

  :host([data-size='md']) {
    height: 36px;
  }
`;var Ge=function(t,e,o,i){var n=arguments.length,r=n<3?e:i===null?i=Object.getOwnPropertyDescriptor(e,o):i,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")r=Reflect.decorate(t,e,o,i);else for(var l=t.length-1;l>=0;l--)(s=t[l])&&(r=(n<3?s(r):n>3?s(e,o,r):s(e,o))||r);return n>3&&r&&Object.defineProperty(e,o,r),r},ve=class extends m{constructor(){super(...arguments),this.tabs=[],this.onTabChange=()=>null,this.size="md",this.activeTab=0}render(){return this.dataset.size=this.size,this.tabs.map((e,o)=>{let i=o===this.activeTab;return c`
        <wui-tab-item
          @click=${()=>this.onTabClick(o)}
          icon=${e.icon}
          size=${this.size}
          label=${e.label}
          ?active=${i}
          data-active=${i}
          data-testid="tab-${e.label?.toLowerCase()}"
        ></wui-tab-item>
      `})}onTabClick(e){this.activeTab=e,this.onTabChange(e)}};ve.styles=[T,z,vo];Ge([u({type:Array})],ve.prototype,"tabs",void 0);Ge([u()],ve.prototype,"onTabChange",void 0);Ge([u()],ve.prototype,"size",void 0);Ge([h()],ve.prototype,"activeTab",void 0);ve=Ge([p("wui-tabs")],ve);var Dt=function(t,e,o,i){var n=arguments.length,r=n<3?e:i===null?i=Object.getOwnPropertyDescriptor(e,o):i,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")r=Reflect.decorate(t,e,o,i);else for(var l=t.length-1;l>=0;l--)(s=t[l])&&(r=(n<3?s(r):n>3?s(e,o,r):s(e,o))||r);return n>3&&r&&Object.defineProperty(e,o,r),r},ut=class extends m{constructor(){super(...arguments),this.platformTabs=[],this.unsubscribe=[],this.platforms=[],this.onSelectPlatfrom=void 0}disconnectCallback(){this.unsubscribe.forEach(e=>e())}render(){let e=this.generateTabs();return c`
      <wui-flex justifyContent="center" .padding=${["0","0","4","0"]}>
        <wui-tabs .tabs=${e} .onTabChange=${this.onTabChange.bind(this)}></wui-tabs>
      </wui-flex>
    `}generateTabs(){let e=this.platforms.map(o=>o==="browser"?{label:"Browser",icon:"extension",platform:"browser"}:o==="mobile"?{label:"Mobile",icon:"mobile",platform:"mobile"}:o==="qrcode"?{label:"Mobile",icon:"mobile",platform:"qrcode"}:o==="web"?{label:"Webapp",icon:"browser",platform:"web"}:o==="desktop"?{label:"Desktop",icon:"desktop",platform:"desktop"}:{label:"Browser",icon:"extension",platform:"unsupported"});return this.platformTabs=e.map(({platform:o})=>o),e}onTabChange(e){let o=this.platformTabs[e];o&&this.onSelectPlatfrom?.(o)}};Dt([u({type:Array})],ut.prototype,"platforms",void 0);Dt([u()],ut.prototype,"onSelectPlatfrom",void 0);ut=Dt([p("w3m-connecting-header")],ut);var $o=C`
  :host {
    width: var(--local-width);
  }

  button {
    width: var(--local-width);
    white-space: nowrap;
    column-gap: ${({spacing:t})=>t[2]};
    transition:
      scale ${({durations:t})=>t.lg} ${({easings:t})=>t["ease-out-power-1"]},
      background-color ${({durations:t})=>t.lg}
        ${({easings:t})=>t["ease-out-power-2"]},
      border-radius ${({durations:t})=>t.lg}
        ${({easings:t})=>t["ease-out-power-1"]};
    will-change: scale, background-color, border-radius;
    cursor: pointer;
  }

  /* -- Sizes --------------------------------------------------- */
  button[data-size='sm'] {
    border-radius: ${({borderRadius:t})=>t[2]};
    padding: 0 ${({spacing:t})=>t[2]};
    height: 28px;
  }

  button[data-size='md'] {
    border-radius: ${({borderRadius:t})=>t[3]};
    padding: 0 ${({spacing:t})=>t[4]};
    height: 38px;
  }

  button[data-size='lg'] {
    border-radius: ${({borderRadius:t})=>t[4]};
    padding: 0 ${({spacing:t})=>t[5]};
    height: 48px;
  }

  /* -- Variants --------------------------------------------------------- */
  button[data-variant='accent-primary'] {
    background-color: ${({tokens:t})=>t.core.backgroundAccentPrimary};
    color: ${({tokens:t})=>t.theme.textInvert};
  }

  button[data-variant='accent-secondary'] {
    background-color: ${({tokens:t})=>t.core.foregroundAccent010};
    color: ${({tokens:t})=>t.core.textAccentPrimary};
  }

  button[data-variant='neutral-primary'] {
    background-color: ${({tokens:t})=>t.theme.backgroundInvert};
    color: ${({tokens:t})=>t.theme.textInvert};
  }

  button[data-variant='neutral-secondary'] {
    background-color: transparent;
    border: 1px solid ${({tokens:t})=>t.theme.borderSecondary};
    color: ${({tokens:t})=>t.theme.textPrimary};
  }

  button[data-variant='neutral-tertiary'] {
    background-color: ${({tokens:t})=>t.theme.foregroundPrimary};
    color: ${({tokens:t})=>t.theme.textPrimary};
  }

  button[data-variant='error-primary'] {
    background-color: ${({tokens:t})=>t.core.textError};
    color: ${({tokens:t})=>t.theme.textInvert};
  }

  button[data-variant='error-secondary'] {
    background-color: ${({tokens:t})=>t.core.backgroundError};
    color: ${({tokens:t})=>t.core.textError};
  }

  button[data-variant='shade'] {
    background: var(--wui-color-gray-glass-002);
    color: var(--wui-color-fg-200);
    border: none;
    box-shadow: inset 0 0 0 1px var(--wui-color-gray-glass-005);
  }

  /* -- Focus states --------------------------------------------------- */
  button[data-size='sm']:focus-visible:enabled {
    border-radius: 28px;
  }

  button[data-size='md']:focus-visible:enabled {
    border-radius: 38px;
  }

  button[data-size='lg']:focus-visible:enabled {
    border-radius: 48px;
  }
  button[data-variant='shade']:focus-visible:enabled {
    background: var(--wui-color-gray-glass-005);
    box-shadow:
      inset 0 0 0 1px var(--wui-color-gray-glass-010),
      0 0 0 4px var(--wui-color-gray-glass-002);
  }

  /* -- Hover & Active states ----------------------------------------------------------- */
  @media (hover: hover) {
    button[data-size='sm']:hover:enabled {
      border-radius: 28px;
    }

    button[data-size='md']:hover:enabled {
      border-radius: 38px;
    }

    button[data-size='lg']:hover:enabled {
      border-radius: 48px;
    }

    button[data-variant='shade']:hover:enabled {
      background: var(--wui-color-gray-glass-002);
    }

    button[data-variant='shade']:active:enabled {
      background: var(--wui-color-gray-glass-005);
    }
  }

  button[data-size='sm']:active:enabled {
    border-radius: 28px;
  }

  button[data-size='md']:active:enabled {
    border-radius: 38px;
  }

  button[data-size='lg']:active:enabled {
    border-radius: 48px;
  }

  /* -- Disabled states --------------------------------------------------- */
  button:disabled {
    opacity: 0.3;
  }
`;var $e=function(t,e,o,i){var n=arguments.length,r=n<3?e:i===null?i=Object.getOwnPropertyDescriptor(e,o):i,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")r=Reflect.decorate(t,e,o,i);else for(var l=t.length-1;l>=0;l--)(s=t[l])&&(r=(n<3?s(r):n>3?s(e,o,r):s(e,o))||r);return n>3&&r&&Object.defineProperty(e,o,r),r},di={lg:"lg-regular-mono",md:"md-regular-mono",sm:"sm-regular-mono"},pi={lg:"md",md:"md",sm:"sm"},le=class extends m{constructor(){super(...arguments),this.size="lg",this.disabled=!1,this.fullWidth=!1,this.loading=!1,this.variant="accent-primary"}render(){this.style.cssText=`
    --local-width: ${this.fullWidth?"100%":"auto"};
     `;let e=this.textVariant??di[this.size];return c`
      <button data-variant=${this.variant} data-size=${this.size} ?disabled=${this.disabled}>
        ${this.loadingTemplate()}
        <slot name="iconLeft"></slot>
        <wui-text variant=${e} color="inherit">
          <slot></slot>
        </wui-text>
        <slot name="iconRight"></slot>
      </button>
    `}loadingTemplate(){if(this.loading){let e=pi[this.size],o=this.variant==="neutral-primary"||this.variant==="accent-primary"?"invert":"primary";return c`<wui-loading-spinner color=${o} size=${e}></wui-loading-spinner>`}return null}};le.styles=[T,z,$o];$e([u()],le.prototype,"size",void 0);$e([u({type:Boolean})],le.prototype,"disabled",void 0);$e([u({type:Boolean})],le.prototype,"fullWidth",void 0);$e([u({type:Boolean})],le.prototype,"loading",void 0);$e([u()],le.prototype,"variant",void 0);$e([u()],le.prototype,"textVariant",void 0);le=$e([p("wui-button")],le);var Eo=C`
  :host {
    display: block;
    width: 100px;
    height: 100px;
  }

  svg {
    width: 100px;
    height: 100px;
  }

  rect {
    fill: none;
    stroke: ${t=>t.colors.accent100};
    stroke-width: 3px;
    stroke-linecap: round;
    animation: dash 1s linear infinite;
  }

  @keyframes dash {
    to {
      stroke-dashoffset: 0px;
    }
  }
`;var Ro=function(t,e,o,i){var n=arguments.length,r=n<3?e:i===null?i=Object.getOwnPropertyDescriptor(e,o):i,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")r=Reflect.decorate(t,e,o,i);else for(var l=t.length-1;l>=0;l--)(s=t[l])&&(r=(n<3?s(r):n>3?s(e,o,r):s(e,o))||r);return n>3&&r&&Object.defineProperty(e,o,r),r},dt=class extends m{constructor(){super(...arguments),this.radius=36}render(){return this.svgLoaderTemplate()}svgLoaderTemplate(){let e=this.radius>50?50:this.radius,i=36-e,n=116+i,r=245+i,s=360+i*1.75;return c`
      <svg viewBox="0 0 110 110" width="110" height="110">
        <rect
          x="2"
          y="2"
          width="106"
          height="106"
          rx=${e}
          stroke-dasharray="${n} ${r}"
          stroke-dashoffset=${s}
        />
      </svg>
    `}};dt.styles=[T,Eo];Ro([u({type:Number})],dt.prototype,"radius",void 0);dt=Ro([p("wui-loading-thumbnail")],dt);var So=C`
  wui-flex {
    width: 100%;
    height: 52px;
    box-sizing: border-box;
    background-color: ${({tokens:t})=>t.theme.foregroundPrimary};
    border-radius: ${({borderRadius:t})=>t[5]};
    padding-left: ${({spacing:t})=>t[3]};
    padding-right: ${({spacing:t})=>t[3]};
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: ${({spacing:t})=>t[6]};
  }

  wui-text {
    color: ${({tokens:t})=>t.theme.textSecondary};
  }

  wui-icon {
    width: 12px;
    height: 12px;
  }
`;var pt=function(t,e,o,i){var n=arguments.length,r=n<3?e:i===null?i=Object.getOwnPropertyDescriptor(e,o):i,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")r=Reflect.decorate(t,e,o,i);else for(var l=t.length-1;l>=0;l--)(s=t[l])&&(r=(n<3?s(r):n>3?s(e,o,r):s(e,o))||r);return n>3&&r&&Object.defineProperty(e,o,r),r},Pe=class extends m{constructor(){super(...arguments),this.disabled=!1,this.label="",this.buttonLabel=""}render(){return c`
      <wui-flex justifyContent="space-between" alignItems="center">
        <wui-text variant="lg-regular" color="inherit">${this.label}</wui-text>
        <wui-button variant="accent-secondary" size="sm">
          ${this.buttonLabel}
          <wui-icon name="chevronRight" color="inherit" size="inherit" slot="iconRight"></wui-icon>
        </wui-button>
      </wui-flex>
    `}};Pe.styles=[T,z,So];pt([u({type:Boolean})],Pe.prototype,"disabled",void 0);pt([u()],Pe.prototype,"label",void 0);pt([u()],Pe.prototype,"buttonLabel",void 0);Pe=pt([p("wui-cta-button")],Pe);var _o=C`
  :host {
    display: block;
    padding: 0 ${({spacing:t})=>t[5]} ${({spacing:t})=>t[5]};
  }
`;var To=function(t,e,o,i){var n=arguments.length,r=n<3?e:i===null?i=Object.getOwnPropertyDescriptor(e,o):i,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")r=Reflect.decorate(t,e,o,i);else for(var l=t.length-1;l>=0;l--)(s=t[l])&&(r=(n<3?s(r):n>3?s(e,o,r):s(e,o))||r);return n>3&&r&&Object.defineProperty(e,o,r),r},ht=class extends m{constructor(){super(...arguments),this.wallet=void 0}render(){if(!this.wallet)return this.style.display="none",null;let{name:e,app_store:o,play_store:i,chrome_store:n,homepage:r}=this.wallet,s=w.isMobile(),l=w.isIos(),a=w.isAndroid(),d=[o,i,r,n].filter(Boolean).length>1,b=J.getTruncateString({string:e,charsStart:12,charsEnd:0,truncate:"end"});return d&&!s?c`
        <wui-cta-button
          label=${`Don't have ${b}?`}
          buttonLabel="Get"
          @click=${()=>f.push("Downloads",{wallet:this.wallet})}
        ></wui-cta-button>
      `:!d&&r?c`
        <wui-cta-button
          label=${`Don't have ${b}?`}
          buttonLabel="Get"
          @click=${this.onHomePage.bind(this)}
        ></wui-cta-button>
      `:o&&l?c`
        <wui-cta-button
          label=${`Don't have ${b}?`}
          buttonLabel="Get"
          @click=${this.onAppStore.bind(this)}
        ></wui-cta-button>
      `:i&&a?c`
        <wui-cta-button
          label=${`Don't have ${b}?`}
          buttonLabel="Get"
          @click=${this.onPlayStore.bind(this)}
        ></wui-cta-button>
      `:(this.style.display="none",null)}onAppStore(){this.wallet?.app_store&&w.openHref(this.wallet.app_store,"_blank")}onPlayStore(){this.wallet?.play_store&&w.openHref(this.wallet.play_store,"_blank")}onHomePage(){this.wallet?.homepage&&w.openHref(this.wallet.homepage,"_blank")}};ht.styles=[_o];To([u({type:Object})],ht.prototype,"wallet",void 0);ht=To([p("w3m-mobile-download-links")],ht);var Ao=C`
  @keyframes shake {
    0% {
      transform: translateX(0);
    }
    25% {
      transform: translateX(3px);
    }
    50% {
      transform: translateX(-3px);
    }
    75% {
      transform: translateX(3px);
    }
    100% {
      transform: translateX(0);
    }
  }

  wui-flex:first-child:not(:only-child) {
    position: relative;
  }

  wui-wallet-image {
    width: 56px;
    height: 56px;
  }

  wui-loading-thumbnail {
    position: absolute;
  }

  wui-icon-box {
    position: absolute;
    right: calc(${({spacing:t})=>t[1]} * -1);
    bottom: calc(${({spacing:t})=>t[1]} * -1);
    opacity: 0;
    transform: scale(0.5);
    transition-property: opacity, transform;
    transition-duration: ${({durations:t})=>t.lg};
    transition-timing-function: ${({easings:t})=>t["ease-out-power-2"]};
    will-change: opacity, transform;
  }

  wui-text[align='center'] {
    width: 100%;
    padding: 0px ${({spacing:t})=>t[4]};
  }

  [data-error='true'] wui-icon-box {
    opacity: 1;
    transform: scale(1);
  }

  [data-error='true'] > wui-flex:first-child {
    animation: shake 250ms ${({easings:t})=>t["ease-out-power-2"]} both;
  }

  [data-retry='false'] wui-link {
    display: none;
  }

  [data-retry='true'] wui-link {
    display: block;
    opacity: 1;
  }

  w3m-mobile-download-links {
    padding: 0px;
    width: 100%;
  }
`;var Z=function(t,e,o,i){var n=arguments.length,r=n<3?e:i===null?i=Object.getOwnPropertyDescriptor(e,o):i,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")r=Reflect.decorate(t,e,o,i);else for(var l=t.length-1;l>=0;l--)(s=t[l])&&(r=(n<3?s(r):n>3?s(e,o,r):s(e,o))||r);return n>3&&r&&Object.defineProperty(e,o,r),r},k=class extends m{constructor(){super(),this.wallet=f.state.data?.wallet,this.connector=f.state.data?.connector,this.timeout=void 0,this.secondaryBtnIcon="refresh",this.onConnect=void 0,this.onRender=void 0,this.onAutoConnect=void 0,this.isWalletConnect=!0,this.unsubscribe=[],this.imageSrc=V.getConnectorImage(this.connector)??V.getWalletImage(this.wallet),this.name=this.wallet?.name??this.connector?.name??"Wallet",this.isRetrying=!1,this.uri=x.state.wcUri,this.error=x.state.wcError,this.ready=!1,this.showRetry=!1,this.label=void 0,this.secondaryBtnLabel="Try again",this.secondaryLabel="Accept connection request in the wallet",this.isLoading=!1,this.isMobile=!1,this.onRetry=void 0,this.unsubscribe.push(x.subscribeKey("wcUri",e=>{this.uri=e,this.isRetrying&&this.onRetry&&(this.isRetrying=!1,this.onConnect?.())}),x.subscribeKey("wcError",e=>this.error=e)),(w.isTelegram()||w.isSafari())&&w.isIos()&&x.state.wcUri&&this.onConnect?.()}firstUpdated(){this.onAutoConnect?.(),this.showRetry=!this.onAutoConnect}disconnectedCallback(){this.unsubscribe.forEach(e=>e()),x.setWcError(!1),clearTimeout(this.timeout)}render(){this.onRender?.(),this.onShowRetry();let e=this.error?"Connection can be declined if a previous request is still active":this.secondaryLabel,o="";return this.label?o=this.label:(o=`Continue in ${this.name}`,this.error&&(o="Connection declined")),c`
      <wui-flex
        data-error=${$(this.error)}
        data-retry=${this.showRetry}
        flexDirection="column"
        alignItems="center"
        .padding=${["10","5","5","5"]}
        gap="6"
      >
        <wui-flex gap="2" justifyContent="center" alignItems="center">
          <wui-wallet-image size="lg" imageSrc=${$(this.imageSrc)}></wui-wallet-image>

          ${this.error?null:this.loaderTemplate()}

          <wui-icon-box
            color="error"
            icon="close"
            size="sm"
            border
            borderColor="wui-color-bg-125"
          ></wui-icon-box>
        </wui-flex>

        <wui-flex flexDirection="column" alignItems="center" gap="6"> <wui-flex
          flexDirection="column"
          alignItems="center"
          gap="2"
          .padding=${["2","0","0","0"]}
        >
          <wui-text align="center" variant="lg-medium" color=${this.error?"error":"primary"}>
            ${o}
          </wui-text>
          <wui-text align="center" variant="lg-regular" color="secondary">${e}</wui-text>
        </wui-flex>

        ${this.secondaryBtnLabel?c`
                <wui-button
                  variant="neutral-secondary"
                  size="md"
                  ?disabled=${this.isRetrying||this.isLoading}
                  @click=${this.onTryAgain.bind(this)}
                  data-testid="w3m-connecting-widget-secondary-button"
                >
                  <wui-icon
                    color="inherit"
                    slot="iconLeft"
                    name=${this.secondaryBtnIcon}
                  ></wui-icon>
                  ${this.secondaryBtnLabel}
                </wui-button>
              `:null}
      </wui-flex>

      ${this.isWalletConnect?c`
              <wui-flex .padding=${["0","5","5","5"]} justifyContent="center">
                <wui-link
                  @click=${this.onCopyUri}
                  variant="secondary"
                  icon="copy"
                  data-testid="wui-link-copy"
                >
                  Copy link
                </wui-link>
              </wui-flex>
            `:null}

      <w3m-mobile-download-links .wallet=${this.wallet}></w3m-mobile-download-links></wui-flex>
      </wui-flex>
    `}onShowRetry(){this.error&&!this.showRetry&&(this.showRetry=!0,this.shadowRoot?.querySelector("wui-button")?.animate([{opacity:0},{opacity:1}],{fill:"forwards",easing:"ease"}))}onTryAgain(){x.setWcError(!1),this.onRetry?(this.isRetrying=!0,this.onRetry?.()):this.onConnect?.()}loaderTemplate(){let e=Ve.state.themeVariables["--w3m-border-radius-master"],o=e?parseInt(e.replace("px",""),10):4;return c`<wui-loading-thumbnail radius=${o*9}></wui-loading-thumbnail>`}onCopyUri(){try{this.uri&&(w.copyToClopboard(this.uri),de.showSuccess("Link copied"))}catch{de.showError("Failed to copy")}}};k.styles=Ao;Z([h()],k.prototype,"isRetrying",void 0);Z([h()],k.prototype,"uri",void 0);Z([h()],k.prototype,"error",void 0);Z([h()],k.prototype,"ready",void 0);Z([h()],k.prototype,"showRetry",void 0);Z([h()],k.prototype,"label",void 0);Z([h()],k.prototype,"secondaryBtnLabel",void 0);Z([h()],k.prototype,"secondaryLabel",void 0);Z([h()],k.prototype,"isLoading",void 0);Z([u({type:Boolean})],k.prototype,"isMobile",void 0);Z([u()],k.prototype,"onRetry",void 0);var hi=function(t,e,o,i){var n=arguments.length,r=n<3?e:i===null?i=Object.getOwnPropertyDescriptor(e,o):i,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")r=Reflect.decorate(t,e,o,i);else for(var l=t.length-1;l>=0;l--)(s=t[l])&&(r=(n<3?s(r):n>3?s(e,o,r):s(e,o))||r);return n>3&&r&&Object.defineProperty(e,o,r),r},Io=class extends k{constructor(){if(super(),!this.wallet)throw new Error("w3m-connecting-wc-browser: No wallet provided");this.onConnect=this.onConnectProxy.bind(this),this.onAutoConnect=this.onConnectProxy.bind(this),W.sendEvent({type:"track",event:"SELECT_WALLET",properties:{name:this.wallet.name,platform:"browser",displayIndex:this.wallet?.display_index,walletRank:this.wallet.order,view:f.state.view}})}async onConnectProxy(){try{this.error=!1;let{connectors:e}=U.state,o=e.find(i=>i.type==="ANNOUNCED"&&i.info?.rdns===this.wallet?.rdns||i.type==="INJECTED"||i.name===this.wallet?.name);if(o)await x.connectExternal(o,o.chain);else throw new Error("w3m-connecting-wc-browser: No connector found");at.close(),W.sendEvent({type:"track",event:"CONNECT_SUCCESS",properties:{method:"browser",name:this.wallet?.name||"Unknown",view:f.state.view,walletRank:this.wallet?.order}})}catch(e){e instanceof lt&&e.originalName===nt.PROVIDER_RPC_ERROR_NAME.USER_REJECTED_REQUEST?W.sendEvent({type:"track",event:"USER_REJECTED",properties:{message:e.message}}):W.sendEvent({type:"track",event:"CONNECT_ERROR",properties:{message:e?.message??"Unknown"}}),this.error=!0}}};Io=hi([p("w3m-connecting-wc-browser")],Io);var mi=function(t,e,o,i){var n=arguments.length,r=n<3?e:i===null?i=Object.getOwnPropertyDescriptor(e,o):i,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")r=Reflect.decorate(t,e,o,i);else for(var l=t.length-1;l>=0;l--)(s=t[l])&&(r=(n<3?s(r):n>3?s(e,o,r):s(e,o))||r);return n>3&&r&&Object.defineProperty(e,o,r),r},Wo=class extends k{constructor(){if(super(),!this.wallet)throw new Error("w3m-connecting-wc-desktop: No wallet provided");this.onConnect=this.onConnectProxy.bind(this),this.onRender=this.onRenderProxy.bind(this),W.sendEvent({type:"track",event:"SELECT_WALLET",properties:{name:this.wallet.name,platform:"desktop",displayIndex:this.wallet?.display_index,walletRank:this.wallet.order,view:f.state.view}})}onRenderProxy(){!this.ready&&this.uri&&(this.ready=!0,this.onConnect?.())}onConnectProxy(){if(this.wallet?.desktop_link&&this.uri)try{this.error=!1;let{desktop_link:e,name:o}=this.wallet,{redirect:i,href:n}=w.formatNativeUrl(e,this.uri);x.setWcLinking({name:o,href:n}),x.setRecentWallet(this.wallet),w.openHref(i,"_blank")}catch{this.error=!0}}};Wo=mi([p("w3m-connecting-wc-desktop")],Wo);var Ne=function(t,e,o,i){var n=arguments.length,r=n<3?e:i===null?i=Object.getOwnPropertyDescriptor(e,o):i,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")r=Reflect.decorate(t,e,o,i);else for(var l=t.length-1;l>=0;l--)(s=t[l])&&(r=(n<3?s(r):n>3?s(e,o,r):s(e,o))||r);return n>3&&r&&Object.defineProperty(e,o,r),r},Ee=class extends k{constructor(){if(super(),this.btnLabelTimeout=void 0,this.redirectDeeplink=void 0,this.redirectUniversalLink=void 0,this.target=void 0,this.preferUniversalLinks=N.state.experimental_preferUniversalLinks,this.isLoading=!0,this.onConnect=()=>{if(this.wallet?.mobile_link&&this.uri)try{this.error=!1;let{mobile_link:e,link_mode:o,name:i}=this.wallet,{redirect:n,redirectUniversalLink:r,href:s}=w.formatNativeUrl(e,this.uri,o);this.redirectDeeplink=n,this.redirectUniversalLink=r,this.target=w.isIframe()?"_top":"_self",x.setWcLinking({name:i,href:s}),x.setRecentWallet(this.wallet),this.preferUniversalLinks&&this.redirectUniversalLink?w.openHref(this.redirectUniversalLink,this.target):w.openHref(this.redirectDeeplink,this.target)}catch(e){W.sendEvent({type:"track",event:"CONNECT_PROXY_ERROR",properties:{message:e instanceof Error?e.message:"Error parsing the deeplink",uri:this.uri,mobile_link:this.wallet.mobile_link,name:this.wallet.name}}),this.error=!0}},!this.wallet)throw new Error("w3m-connecting-wc-mobile: No wallet provided");this.secondaryBtnLabel="Open",this.secondaryLabel=st.CONNECT_LABELS.MOBILE,this.secondaryBtnIcon="externalLink",this.onHandleURI(),this.unsubscribe.push(x.subscribeKey("wcUri",()=>{this.onHandleURI()})),W.sendEvent({type:"track",event:"SELECT_WALLET",properties:{name:this.wallet.name,platform:"mobile",displayIndex:this.wallet?.display_index,walletRank:this.wallet.order,view:f.state.view}})}disconnectedCallback(){super.disconnectedCallback(),clearTimeout(this.btnLabelTimeout)}onHandleURI(){this.isLoading=!this.uri,!this.ready&&this.uri&&(this.ready=!0,this.onConnect?.())}onTryAgain(){x.setWcError(!1),this.onConnect?.()}};Ne([h()],Ee.prototype,"redirectDeeplink",void 0);Ne([h()],Ee.prototype,"redirectUniversalLink",void 0);Ne([h()],Ee.prototype,"target",void 0);Ne([h()],Ee.prototype,"preferUniversalLinks",void 0);Ne([h()],Ee.prototype,"isLoading",void 0);Ee=Ne([p("w3m-connecting-wc-mobile")],Ee);var Br=li(Lr(),1);var un=.1,kr=2.5,ce=7;function lo(t,e,o){return t===e?!1:(t-e<0?e-t:t-e)<=o+un}function dn(t,e){let o=Array.prototype.slice.call(Br.default.create(t,{errorCorrectionLevel:e}).modules.data,0),i=Math.sqrt(o.length);return o.reduce((n,r,s)=>(s%i===0?n.push([r]):n[n.length-1].push(r))&&n,[])}var Pr={generate({uri:t,size:e,logoSize:o,padding:i=8,dotColor:n="var(--apkt-colors-black)"}){let s=[],l=dn(t,"Q"),a=(e-2*i)/l.length,d=[{x:0,y:0},{x:1,y:0},{x:0,y:1}];d.forEach(({x:y,y:g})=>{let I=(l.length-ce)*a*y+i,S=(l.length-ce)*a*g+i,M=.45;for(let P=0;P<d.length;P+=1){let O=a*(ce-P*2);s.push(he`
            <rect
              fill=${P===2?"var(--apkt-colors-black)":"var(--apkt-colors-white)"}
              width=${P===0?O-10:O}
              rx= ${P===0?(O-10)*M:O*M}
              ry= ${P===0?(O-10)*M:O*M}
              stroke=${n}
              stroke-width=${P===0?10:0}
              height=${P===0?O-10:O}
              x= ${P===0?S+a*P+10/2:S+a*P}
              y= ${P===0?I+a*P+10/2:I+a*P}
            />
          `)}});let b=Math.floor((o+25)/a),B=l.length/2-b/2,R=l.length/2+b/2-1,j=[];l.forEach((y,g)=>{y.forEach((I,S)=>{if(l[g][S]&&!(g<ce&&S<ce||g>l.length-(ce+1)&&S<ce||g<ce&&S>l.length-(ce+1))&&!(g>B&&g<R&&S>B&&S<R)){let M=g*a+a/2+i,P=S*a+a/2+i;j.push([M,P])}})});let L={};return j.forEach(([y,g])=>{L[y]?L[y]?.push(g):L[y]=[g]}),Object.entries(L).map(([y,g])=>{let I=g.filter(S=>g.every(M=>!lo(S,M,a)));return[Number(y),I]}).forEach(([y,g])=>{g.forEach(I=>{s.push(he`<circle cx=${y} cy=${I} fill=${n} r=${a/kr} />`)})}),Object.entries(L).filter(([y,g])=>g.length>1).map(([y,g])=>{let I=g.filter(S=>g.some(M=>lo(S,M,a)));return[Number(y),I]}).map(([y,g])=>{g.sort((S,M)=>S<M?-1:1);let I=[];for(let S of g){let M=I.find(P=>P.some(O=>lo(S,O,a)));M?M.push(S):I.push([S])}return[y,I.map(S=>[S[0],S[S.length-1]])]}).forEach(([y,g])=>{g.forEach(([I,S])=>{s.push(he`
              <line
                x1=${y}
                x2=${y}
                y1=${I}
                y2=${S}
                stroke=${n}
                stroke-width=${a/(kr/2)}
                stroke-linecap="round"
              />
            `)})}),s}};var Nr=C`
  :host {
    position: relative;
    user-select: none;
    display: block;
    overflow: hidden;
    aspect-ratio: 1 / 1;
    width: 100%;
    height: 100%;
    background-color: ${({colors:t})=>t.white};
    border: 1px solid ${({tokens:t})=>t.theme.borderPrimary};
  }

  :host {
    border-radius: ${({borderRadius:t})=>t[4]};
    display: flex;
    align-items: center;
    justify-content: center;
  }

  :host([data-clear='true']) > wui-icon {
    display: none;
  }

  svg:first-child,
  wui-image,
  wui-icon {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translateY(-50%) translateX(-50%);
    background-color: ${({tokens:t})=>t.theme.backgroundPrimary};
    box-shadow: inset 0 0 0 4px ${({tokens:t})=>t.theme.backgroundPrimary};
    border-radius: ${({borderRadius:t})=>t[6]};
  }

  wui-image {
    width: 25%;
    height: 25%;
    border-radius: ${({borderRadius:t})=>t[2]};
  }

  wui-icon {
    width: 100%;
    height: 100%;
    color: #3396ff !important;
    transform: translateY(-50%) translateX(-50%) scale(0.25);
  }

  wui-icon > svg {
    width: inherit;
    height: inherit;
  }
`;var be=function(t,e,o,i){var n=arguments.length,r=n<3?e:i===null?i=Object.getOwnPropertyDescriptor(e,o):i,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")r=Reflect.decorate(t,e,o,i);else for(var l=t.length-1;l>=0;l--)(s=t[l])&&(r=(n<3?s(r):n>3?s(e,o,r):s(e,o))||r);return n>3&&r&&Object.defineProperty(e,o,r),r},ee=class extends m{constructor(){super(...arguments),this.uri="",this.size=0,this.theme="dark",this.imageSrc=void 0,this.alt=void 0,this.arenaClear=void 0,this.farcaster=void 0}render(){return this.dataset.theme=this.theme,this.dataset.clear=String(this.arenaClear),this.style.cssText=`--local-size: ${this.size}px`,c`<wui-flex
      alignItems="center"
      justifyContent="center"
      class="wui-qr-code"
      direction="column"
      gap="4"
      width="100%"
      style="height: 100%"
    >
      ${this.templateVisual()} ${this.templateSvg()}
    </wui-flex>`}templateSvg(){return he`
      <svg height=${this.size} width=${this.size}>
        ${Pr.generate({uri:this.uri,size:this.size,logoSize:this.arenaClear?0:this.size/4})}
      </svg>
    `}templateVisual(){return this.imageSrc?c`<wui-image src=${this.imageSrc} alt=${this.alt??"logo"}></wui-image>`:this.farcaster?c`<wui-icon
        class="farcaster"
        size="inherit"
        color="inherit"
        name="farcaster"
      ></wui-icon>`:c`<wui-icon size="inherit" color="inherit" name="walletConnect"></wui-icon>`}};ee.styles=[T,Nr];be([u()],ee.prototype,"uri",void 0);be([u({type:Number})],ee.prototype,"size",void 0);be([u()],ee.prototype,"theme",void 0);be([u()],ee.prototype,"imageSrc",void 0);be([u()],ee.prototype,"alt",void 0);be([u({type:Boolean})],ee.prototype,"arenaClear",void 0);be([u({type:Boolean})],ee.prototype,"farcaster",void 0);ee=be([p("wui-qr-code")],ee);var Or=C`
  :host {
    display: block;
    background: linear-gradient(
      90deg,
      ${({tokens:t})=>t.theme.foregroundSecondary} 0%,
      ${({tokens:t})=>t.theme.foregroundTertiary} 50%,
      ${({tokens:t})=>t.theme.foregroundSecondary} 100%
    );
    background-size: 200% 100%;
    animation: shimmer 1s ease-in-out infinite;
    border-radius: ${({borderRadius:t})=>t[2]};
  }

  :host([data-rounded='true']) {
    border-radius: ${({borderRadius:t})=>t[16]};
  }

  @keyframes shimmer {
    0% {
      background-position: 200% 0;
    }
    100% {
      background-position: -200% 0;
    }
  }
`;var ot=function(t,e,o,i){var n=arguments.length,r=n<3?e:i===null?i=Object.getOwnPropertyDescriptor(e,o):i,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")r=Reflect.decorate(t,e,o,i);else for(var l=t.length-1;l>=0;l--)(s=t[l])&&(r=(n<3?s(r):n>3?s(e,o,r):s(e,o))||r);return n>3&&r&&Object.defineProperty(e,o,r),r},Ae=class extends m{constructor(){super(...arguments),this.width="",this.height="",this.variant="default",this.rounded=!1}render(){return this.style.cssText=`
      width: ${this.width};
      height: ${this.height};
    `,this.dataset.rounded=this.rounded?"true":"false",c`<slot></slot>`}};Ae.styles=[Or];ot([u()],Ae.prototype,"width",void 0);ot([u()],Ae.prototype,"height",void 0);ot([u()],Ae.prototype,"variant",void 0);ot([u({type:Boolean})],Ae.prototype,"rounded",void 0);Ae=ot([p("wui-shimmer")],Ae);var Dr=C`
  wui-shimmer {
    width: 100%;
    aspect-ratio: 1 / 1;
    border-radius: ${({borderRadius:t})=>t[4]};
  }

  wui-qr-code {
    opacity: 0;
    animation-duration: ${({durations:t})=>t.xl};
    animation-timing-function: ${({easings:t})=>t["ease-out-power-2"]};
    animation-name: fade-in;
    animation-fill-mode: forwards;
  }

  @keyframes fade-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
`;var Mr=function(t,e,o,i){var n=arguments.length,r=n<3?e:i===null?i=Object.getOwnPropertyDescriptor(e,o):i,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")r=Reflect.decorate(t,e,o,i);else for(var l=t.length-1;l>=0;l--)(s=t[l])&&(r=(n<3?s(r):n>3?s(e,o,r):s(e,o))||r);return n>3&&r&&Object.defineProperty(e,o,r),r},Rt=class extends k{constructor(){super(),this.basic=!1,this.forceUpdate=()=>{this.requestUpdate()},window.addEventListener("resize",this.forceUpdate)}firstUpdated(){this.basic||W.sendEvent({type:"track",event:"SELECT_WALLET",properties:{name:this.wallet?.name??"WalletConnect",platform:"qrcode",displayIndex:this.wallet?.display_index,walletRank:this.wallet?.order,view:f.state.view}})}disconnectedCallback(){super.disconnectedCallback(),this.unsubscribe?.forEach(e=>e()),window.removeEventListener("resize",this.forceUpdate)}render(){return this.onRenderProxy(),c`
      <wui-flex
        flexDirection="column"
        alignItems="center"
        .padding=${["0","5","5","5"]}
        gap="5"
      >
        <wui-shimmer width="100%"> ${this.qrCodeTemplate()} </wui-shimmer>
        <wui-text variant="lg-medium" color="primary"> Scan this QR Code with your phone </wui-text>
        ${this.copyTemplate()}
      </wui-flex>
      <w3m-mobile-download-links .wallet=${this.wallet}></w3m-mobile-download-links>
    `}onRenderProxy(){!this.ready&&this.uri&&(this.timeout=setTimeout(()=>{this.ready=!0},200))}qrCodeTemplate(){if(!this.uri||!this.ready)return null;let e=this.getBoundingClientRect().width-40,o=this.wallet?this.wallet.name:void 0;x.setWcLinking(void 0),x.setRecentWallet(this.wallet);let i=this.uri;if(this.wallet?.mobile_link){let{redirect:n}=w.formatNativeUrl(this.wallet?.mobile_link,this.uri,null);i=n}return c` <wui-qr-code
      size=${e}
      theme=${Ve.state.themeMode}
      uri=${i}
      imageSrc=${$(V.getWalletImage(this.wallet))}
      color=${$(Ve.state.themeVariables["--w3m-qr-color"])}
      alt=${$(o)}
      data-testid="wui-qr-code"
    ></wui-qr-code>`}copyTemplate(){let e=!this.uri||!this.ready;return c`<wui-button
      .disabled=${e}
      @click=${this.onCopyUri}
      variant="neutral-secondary"
      size="sm"
      data-testid="copy-wc2-uri"
    >
      Copy link
      <wui-icon size="sm" color="inherit" name="copy" slot="iconRight"></wui-icon>
    </wui-button>`}};Rt.styles=Dr;Mr([u({type:Boolean})],Rt.prototype,"basic",void 0);Rt=Mr([p("w3m-connecting-wc-qrcode")],Rt);var pn=function(t,e,o,i){var n=arguments.length,r=n<3?e:i===null?i=Object.getOwnPropertyDescriptor(e,o):i,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")r=Reflect.decorate(t,e,o,i);else for(var l=t.length-1;l>=0;l--)(s=t[l])&&(r=(n<3?s(r):n>3?s(e,o,r):s(e,o))||r);return n>3&&r&&Object.defineProperty(e,o,r),r},Ur=class extends m{constructor(){if(super(),this.wallet=f.state.data?.wallet,!this.wallet)throw new Error("w3m-connecting-wc-unsupported: No wallet provided");W.sendEvent({type:"track",event:"SELECT_WALLET",properties:{name:this.wallet.name,platform:"browser",displayIndex:this.wallet?.display_index,walletRank:this.wallet?.order,view:f.state.view}})}render(){return c`
      <wui-flex
        flexDirection="column"
        alignItems="center"
        .padding=${["10","5","5","5"]}
        gap="5"
      >
        <wui-wallet-image
          size="lg"
          imageSrc=${$(V.getWalletImage(this.wallet))}
        ></wui-wallet-image>

        <wui-text variant="md-regular" color="primary">Not Detected</wui-text>
      </wui-flex>

      <w3m-mobile-download-links .wallet=${this.wallet}></w3m-mobile-download-links>
    `}};Ur=pn([p("w3m-connecting-wc-unsupported")],Ur);var zr=function(t,e,o,i){var n=arguments.length,r=n<3?e:i===null?i=Object.getOwnPropertyDescriptor(e,o):i,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")r=Reflect.decorate(t,e,o,i);else for(var l=t.length-1;l>=0;l--)(s=t[l])&&(r=(n<3?s(r):n>3?s(e,o,r):s(e,o))||r);return n>3&&r&&Object.defineProperty(e,o,r),r},ao=class extends k{constructor(){if(super(),this.isLoading=!0,!this.wallet)throw new Error("w3m-connecting-wc-web: No wallet provided");this.onConnect=this.onConnectProxy.bind(this),this.secondaryBtnLabel="Open",this.secondaryLabel=st.CONNECT_LABELS.MOBILE,this.secondaryBtnIcon="externalLink",this.updateLoadingState(),this.unsubscribe.push(x.subscribeKey("wcUri",()=>{this.updateLoadingState()})),W.sendEvent({type:"track",event:"SELECT_WALLET",properties:{name:this.wallet.name,platform:"web",displayIndex:this.wallet?.display_index,walletRank:this.wallet?.order,view:f.state.view}})}updateLoadingState(){this.isLoading=!this.uri}onConnectProxy(){if(this.wallet?.webapp_link&&this.uri)try{this.error=!1;let{webapp_link:e,name:o}=this.wallet,{redirect:i,href:n}=w.formatUniversalUrl(e,this.uri);x.setWcLinking({name:o,href:n}),x.setRecentWallet(this.wallet),w.openHref(i,"_blank")}catch{this.error=!0}}};zr([h()],ao.prototype,"isLoading",void 0);ao=zr([p("w3m-connecting-wc-web")],ao);var jr=C`
  :host([data-mobile-fullscreen='true']) {
    height: 100%;
    display: flex;
    flex-direction: column;
  }

  :host([data-mobile-fullscreen='true']) wui-ux-by-reown {
    margin-top: auto;
  }
`;var Ie=function(t,e,o,i){var n=arguments.length,r=n<3?e:i===null?i=Object.getOwnPropertyDescriptor(e,o):i,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")r=Reflect.decorate(t,e,o,i);else for(var l=t.length-1;l>=0;l--)(s=t[l])&&(r=(n<3?s(r):n>3?s(e,o,r):s(e,o))||r);return n>3&&r&&Object.defineProperty(e,o,r),r},ue=class extends m{constructor(){super(),this.wallet=f.state.data?.wallet,this.unsubscribe=[],this.platform=void 0,this.platforms=[],this.isSiwxEnabled=!!N.state.siwx,this.remoteFeatures=N.state.remoteFeatures,this.displayBranding=!0,this.basic=!1,this.determinePlatforms(),this.initializeConnection(),this.unsubscribe.push(N.subscribeKey("remoteFeatures",e=>this.remoteFeatures=e))}disconnectedCallback(){this.unsubscribe.forEach(e=>e())}render(){return N.state.enableMobileFullScreen&&this.setAttribute("data-mobile-fullscreen","true"),c`
      ${this.headerTemplate()}
      <div class="platform-container">${this.platformTemplate()}</div>
      ${this.reownBrandingTemplate()}
    `}reownBrandingTemplate(){return!this.remoteFeatures?.reownBranding||!this.displayBranding?null:c`<wui-ux-by-reown></wui-ux-by-reown>`}async initializeConnection(e=!1){if(!(this.platform==="browser"||N.state.manualWCControl&&!e))try{let{wcPairingExpiry:o,status:i}=x.state,{redirectView:n}=f.state.data??{};if(e||N.state.enableEmbedded||w.isPairingExpired(o)||i==="connecting"){let r=x.getConnections(ne.state.activeChain),s=this.remoteFeatures?.multiWallet,l=r.length>0;await x.connectWalletConnect({cache:"never"}),this.isSiwxEnabled||(l&&s?(f.replace("ProfileWallets"),de.showSuccess("New Wallet Added")):n?f.replace(n):at.close())}}catch(o){if(o instanceof Error&&o.message.includes("An error occurred when attempting to switch chain")&&!N.state.enableNetworkSwitch&&ne.state.activeChain){ne.setActiveCaipNetwork(go.getUnsupportedNetwork(`${ne.state.activeChain}:${ne.state.activeCaipNetwork?.id}`)),ne.showUnsupportedChainUI();return}o instanceof lt&&o.originalName===nt.PROVIDER_RPC_ERROR_NAME.USER_REJECTED_REQUEST?W.sendEvent({type:"track",event:"USER_REJECTED",properties:{message:o.message}}):W.sendEvent({type:"track",event:"CONNECT_ERROR",properties:{message:o?.message??"Unknown"}}),x.setWcError(!0),de.showError(o.message??"Connection error"),x.resetWcConnection(),f.goBack()}}determinePlatforms(){if(!this.wallet){this.platforms.push("qrcode"),this.platform="qrcode";return}if(this.platform)return;let{mobile_link:e,desktop_link:o,webapp_link:i,injected:n,rdns:r}=this.wallet,s=n?.map(({injected_id:L})=>L).filter(Boolean),l=[...r?[r]:s??[]],a=N.state.isUniversalProvider?!1:l.length,d=e,b=i,B=x.checkInstalled(l),R=a&&B,j=o&&!w.isMobile();R&&!ne.state.noAdapters&&this.platforms.push("browser"),d&&this.platforms.push(w.isMobile()?"mobile":"qrcode"),b&&this.platforms.push("web"),j&&this.platforms.push("desktop"),!R&&a&&!ne.state.noAdapters&&this.platforms.push("unsupported"),this.platform=this.platforms[0]}platformTemplate(){switch(this.platform){case"browser":return c`<w3m-connecting-wc-browser></w3m-connecting-wc-browser>`;case"web":return c`<w3m-connecting-wc-web></w3m-connecting-wc-web>`;case"desktop":return c`
          <w3m-connecting-wc-desktop .onRetry=${()=>this.initializeConnection(!0)}>
          </w3m-connecting-wc-desktop>
        `;case"mobile":return c`
          <w3m-connecting-wc-mobile isMobile .onRetry=${()=>this.initializeConnection(!0)}>
          </w3m-connecting-wc-mobile>
        `;case"qrcode":return c`<w3m-connecting-wc-qrcode ?basic=${this.basic}></w3m-connecting-wc-qrcode>`;default:return c`<w3m-connecting-wc-unsupported></w3m-connecting-wc-unsupported>`}}headerTemplate(){return this.platforms.length>1?c`
      <w3m-connecting-header
        .platforms=${this.platforms}
        .onSelectPlatfrom=${this.onSelectPlatform.bind(this)}
      >
      </w3m-connecting-header>
    `:null}async onSelectPlatform(e){let o=this.shadowRoot?.querySelector("div");o&&(await o.animate([{opacity:1},{opacity:0}],{duration:200,fill:"forwards",easing:"ease"}).finished,this.platform=e,o.animate([{opacity:0},{opacity:1}],{duration:200,fill:"forwards",easing:"ease"}))}};ue.styles=jr;Ie([h()],ue.prototype,"platform",void 0);Ie([h()],ue.prototype,"platforms",void 0);Ie([h()],ue.prototype,"isSiwxEnabled",void 0);Ie([h()],ue.prototype,"remoteFeatures",void 0);Ie([u({type:Boolean})],ue.prototype,"displayBranding",void 0);Ie([u({type:Boolean})],ue.prototype,"basic",void 0);ue=Ie([p("w3m-connecting-wc-view")],ue);var co=function(t,e,o,i){var n=arguments.length,r=n<3?e:i===null?i=Object.getOwnPropertyDescriptor(e,o):i,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")r=Reflect.decorate(t,e,o,i);else for(var l=t.length-1;l>=0;l--)(s=t[l])&&(r=(n<3?s(r):n>3?s(e,o,r):s(e,o))||r);return n>3&&r&&Object.defineProperty(e,o,r),r},St=class extends m{constructor(){super(),this.unsubscribe=[],this.isMobile=w.isMobile(),this.remoteFeatures=N.state.remoteFeatures,this.unsubscribe.push(N.subscribeKey("remoteFeatures",e=>this.remoteFeatures=e))}disconnectedCallback(){this.unsubscribe.forEach(e=>e())}render(){if(this.isMobile){let{featured:e,recommended:o}=v.state,{customWallets:i}=N.state,n=mo.getRecentWallets(),r=e.length||o.length||i?.length||n.length;return c`<wui-flex flexDirection="column" gap="2" .margin=${["1","3","3","3"]}>
        ${r?c`<w3m-connector-list></w3m-connector-list>`:null}
        <w3m-all-wallets-widget></w3m-all-wallets-widget>
      </wui-flex>`}return c`<wui-flex flexDirection="column" .padding=${["0","0","4","0"]}>
        <w3m-connecting-wc-view ?basic=${!0} .displayBranding=${!1}></w3m-connecting-wc-view>
        <wui-flex flexDirection="column" .padding=${["0","3","0","3"]}>
          <w3m-all-wallets-widget></w3m-all-wallets-widget>
        </wui-flex>
      </wui-flex>
      ${this.reownBrandingTemplate()} `}reownBrandingTemplate(){return this.remoteFeatures?.reownBranding?c` <wui-flex flexDirection="column" .padding=${["1","0","1","0"]}>
      <wui-ux-by-reown></wui-ux-by-reown>
    </wui-flex>`:null}};co([h()],St.prototype,"isMobile",void 0);co([h()],St.prototype,"remoteFeatures",void 0);St=co([p("w3m-connecting-wc-basic-view")],St);var{I:lu}=wo;var qr=t=>t.strings===void 0;var rt=(t,e)=>{let o=t._$AN;if(o===void 0)return!1;for(let i of o)i._$AO?.(e,!1),rt(i,e);return!0},_t=t=>{let e,o;do{if((e=t._$AM)===void 0)break;o=e._$AN,o.delete(t),t=e}while(o?.size===0)},Fr=t=>{for(let e;e=t._$AM;t=e){let o=e._$AN;if(o===void 0)e._$AN=o=new Set;else if(o.has(t))break;o.add(t),fn(e)}};function hn(t){this._$AN!==void 0?(_t(this),this._$AM=t,Fr(this)):this._$AM=t}function mn(t,e=!1,o=0){let i=this._$AH,n=this._$AN;if(n!==void 0&&n.size!==0)if(e)if(Array.isArray(i))for(let r=o;r<i.length;r++)rt(i[r],!1),_t(i[r]);else i!=null&&(rt(i,!1),_t(i));else rt(this,t)}var fn=t=>{t.type==bo.CHILD&&(t._$AP??=mn,t._$AQ??=hn)},Tt=class extends yo{constructor(){super(...arguments),this._$AN=void 0}_$AT(e,o,i){super._$AT(e,o,i),Fr(this),this.isConnected=e._$AU}_$AO(e,o=!0){e!==this.isConnected&&(this.isConnected=e,e?this.reconnected?.():this.disconnected?.()),o&&(rt(this,e),_t(this))}setValue(e){if(qr(this._$Ct))this._$Ct._$AI(e,this);else{let o=[...this._$Ct._$AH];o[this._$Ci]=e,this._$Ct._$AI(o,this,0)}}disconnected(){}reconnected(){}};var je=()=>new po,po=class{},uo=new WeakMap,qe=Ot(class extends Tt{render(t){return Nt}update(t,[e]){let o=e!==this.G;return o&&this.rt(void 0),(o||this.lt!==this.ct)&&(this.G=e,this.ht=t.options?.host,this.rt(this.ct=t.element)),Nt}rt(t){if(this.G!==void 0)if(this.isConnected||(t=void 0),typeof this.G=="function"){let e=this.ht??globalThis,o=uo.get(e);o===void 0&&(o=new WeakMap,uo.set(e,o)),o.get(this.G)!==void 0&&this.G.call(this.ht,void 0),o.set(this.G,t),t!==void 0&&this.G.call(this.ht,t)}else this.G.value=t}get lt(){return typeof this.G=="function"?uo.get(this.ht??globalThis)?.get(this.G):this.G?.value}disconnected(){this.lt===this.ct&&this.rt(void 0)}reconnected(){this.rt(this.ct)}});var Vr=C`
  :host {
    display: flex;
    align-items: center;
    justify-content: center;
  }

  label {
    position: relative;
    display: inline-block;
    user-select: none;
    transition:
      background-color ${({durations:t})=>t.lg}
        ${({easings:t})=>t["ease-out-power-2"]},
      color ${({durations:t})=>t.lg} ${({easings:t})=>t["ease-out-power-2"]},
      border ${({durations:t})=>t.lg} ${({easings:t})=>t["ease-out-power-2"]},
      box-shadow ${({durations:t})=>t.lg}
        ${({easings:t})=>t["ease-out-power-2"]},
      width ${({durations:t})=>t.lg} ${({easings:t})=>t["ease-out-power-2"]},
      height ${({durations:t})=>t.lg} ${({easings:t})=>t["ease-out-power-2"]},
      transform ${({durations:t})=>t.lg}
        ${({easings:t})=>t["ease-out-power-2"]},
      opacity ${({durations:t})=>t.lg} ${({easings:t})=>t["ease-out-power-2"]};
    will-change: background-color, color, border, box-shadow, width, height, transform, opacity;
  }

  input {
    width: 0;
    height: 0;
    opacity: 0;
  }

  span {
    position: absolute;
    cursor: pointer;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background-color: ${({colors:t})=>t.neutrals300};
    border-radius: ${({borderRadius:t})=>t.round};
    border: 1px solid transparent;
    will-change: border;
    transition:
      background-color ${({durations:t})=>t.lg}
        ${({easings:t})=>t["ease-out-power-2"]},
      color ${({durations:t})=>t.lg} ${({easings:t})=>t["ease-out-power-2"]},
      border ${({durations:t})=>t.lg} ${({easings:t})=>t["ease-out-power-2"]},
      box-shadow ${({durations:t})=>t.lg}
        ${({easings:t})=>t["ease-out-power-2"]},
      width ${({durations:t})=>t.lg} ${({easings:t})=>t["ease-out-power-2"]},
      height ${({durations:t})=>t.lg} ${({easings:t})=>t["ease-out-power-2"]},
      transform ${({durations:t})=>t.lg}
        ${({easings:t})=>t["ease-out-power-2"]},
      opacity ${({durations:t})=>t.lg} ${({easings:t})=>t["ease-out-power-2"]};
    will-change: background-color, color, border, box-shadow, width, height, transform, opacity;
  }

  span:before {
    content: '';
    position: absolute;
    background-color: ${({colors:t})=>t.white};
    border-radius: 50%;
  }

  /* -- Sizes --------------------------------------------------------- */
  label[data-size='lg'] {
    width: 48px;
    height: 32px;
  }

  label[data-size='md'] {
    width: 40px;
    height: 28px;
  }

  label[data-size='sm'] {
    width: 32px;
    height: 22px;
  }

  label[data-size='lg'] > span:before {
    height: 24px;
    width: 24px;
    left: 4px;
    top: 3px;
  }

  label[data-size='md'] > span:before {
    height: 20px;
    width: 20px;
    left: 4px;
    top: 3px;
  }

  label[data-size='sm'] > span:before {
    height: 16px;
    width: 16px;
    left: 3px;
    top: 2px;
  }

  /* -- Focus states --------------------------------------------------- */
  input:focus-visible:not(:checked) + span,
  input:focus:not(:checked) + span {
    border: 1px solid ${({tokens:t})=>t.core.iconAccentPrimary};
    background-color: ${({tokens:t})=>t.theme.textTertiary};
    box-shadow: 0px 0px 0px 4px rgba(9, 136, 240, 0.2);
  }

  input:focus-visible:checked + span,
  input:focus:checked + span {
    border: 1px solid ${({tokens:t})=>t.core.iconAccentPrimary};
    box-shadow: 0px 0px 0px 4px rgba(9, 136, 240, 0.2);
  }

  /* -- Checked states --------------------------------------------------- */
  input:checked + span {
    background-color: ${({tokens:t})=>t.core.iconAccentPrimary};
  }

  label[data-size='lg'] > input:checked + span:before {
    transform: translateX(calc(100% - 9px));
  }

  label[data-size='md'] > input:checked + span:before {
    transform: translateX(calc(100% - 9px));
  }

  label[data-size='sm'] > input:checked + span:before {
    transform: translateX(calc(100% - 7px));
  }

  /* -- Hover states ------------------------------------------------------- */
  label:hover > input:not(:checked):not(:disabled) + span {
    background-color: ${({colors:t})=>t.neutrals400};
  }

  label:hover > input:checked:not(:disabled) + span {
    background-color: ${({colors:t})=>t.accent080};
  }

  /* -- Disabled state --------------------------------------------------- */
  label:has(input:disabled) {
    pointer-events: none;
    user-select: none;
  }

  input:not(:checked):disabled + span {
    background-color: ${({colors:t})=>t.neutrals700};
  }

  input:checked:disabled + span {
    background-color: ${({colors:t})=>t.neutrals700};
  }

  input:not(:checked):disabled + span::before {
    background-color: ${({colors:t})=>t.neutrals400};
  }

  input:checked:disabled + span::before {
    background-color: ${({tokens:t})=>t.theme.textTertiary};
  }
`;var At=function(t,e,o,i){var n=arguments.length,r=n<3?e:i===null?i=Object.getOwnPropertyDescriptor(e,o):i,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")r=Reflect.decorate(t,e,o,i);else for(var l=t.length-1;l>=0;l--)(s=t[l])&&(r=(n<3?s(r):n>3?s(e,o,r):s(e,o))||r);return n>3&&r&&Object.defineProperty(e,o,r),r},Fe=class extends m{constructor(){super(...arguments),this.inputElementRef=je(),this.checked=!1,this.disabled=!1,this.size="md"}render(){return c`
      <label data-size=${this.size}>
        <input
          ${qe(this.inputElementRef)}
          type="checkbox"
          ?checked=${this.checked}
          ?disabled=${this.disabled}
          @change=${this.dispatchChangeEvent.bind(this)}
        />
        <span></span>
      </label>
    `}dispatchChangeEvent(){this.dispatchEvent(new CustomEvent("switchChange",{detail:this.inputElementRef.value?.checked,bubbles:!0,composed:!0}))}};Fe.styles=[T,z,Vr];At([u({type:Boolean})],Fe.prototype,"checked",void 0);At([u({type:Boolean})],Fe.prototype,"disabled",void 0);At([u()],Fe.prototype,"size",void 0);Fe=At([p("wui-toggle")],Fe);var Hr=C`
  :host {
    height: auto;
  }

  :host > wui-flex {
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    column-gap: ${({spacing:t})=>t[2]};
    padding: ${({spacing:t})=>t[2]} ${({spacing:t})=>t[3]};
    background-color: ${({tokens:t})=>t.theme.foregroundPrimary};
    border-radius: ${({borderRadius:t})=>t[4]};
    box-shadow: inset 0 0 0 1px ${({tokens:t})=>t.theme.foregroundPrimary};
    transition: background-color ${({durations:t})=>t.lg}
      ${({easings:t})=>t["ease-out-power-2"]};
    will-change: background-color;
    cursor: pointer;
  }

  wui-switch {
    pointer-events: none;
  }
`;var Kr=function(t,e,o,i){var n=arguments.length,r=n<3?e:i===null?i=Object.getOwnPropertyDescriptor(e,o):i,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")r=Reflect.decorate(t,e,o,i);else for(var l=t.length-1;l>=0;l--)(s=t[l])&&(r=(n<3?s(r):n>3?s(e,o,r):s(e,o))||r);return n>3&&r&&Object.defineProperty(e,o,r),r},It=class extends m{constructor(){super(...arguments),this.checked=!1}render(){return c`
      <wui-flex>
        <wui-icon size="xl" name="walletConnectBrown"></wui-icon>
        <wui-toggle
          ?checked=${this.checked}
          size="sm"
          @switchChange=${this.handleToggleChange.bind(this)}
        ></wui-toggle>
      </wui-flex>
    `}handleToggleChange(e){e.stopPropagation(),this.checked=e.detail,this.dispatchSwitchEvent()}dispatchSwitchEvent(){this.dispatchEvent(new CustomEvent("certifiedSwitchChange",{detail:this.checked,bubbles:!0,composed:!0}))}};It.styles=[T,z,Hr];Kr([u({type:Boolean})],It.prototype,"checked",void 0);It=Kr([p("wui-certified-switch")],It);var Gr=C`
  :host {
    position: relative;
    width: 100%;
    display: inline-flex;
    flex-direction: column;
    gap: ${({spacing:t})=>t[3]};
    color: ${({tokens:t})=>t.theme.textPrimary};
    caret-color: ${({tokens:t})=>t.core.textAccentPrimary};
  }

  .wui-input-text-container {
    position: relative;
    display: flex;
  }

  input {
    width: 100%;
    border-radius: ${({borderRadius:t})=>t[4]};
    color: inherit;
    background: transparent;
    border: 1px solid ${({tokens:t})=>t.theme.borderPrimary};
    caret-color: ${({tokens:t})=>t.core.textAccentPrimary};
    padding: ${({spacing:t})=>t[3]} ${({spacing:t})=>t[3]}
      ${({spacing:t})=>t[3]} ${({spacing:t})=>t[10]};
    font-size: ${({textSize:t})=>t.large};
    line-height: ${({typography:t})=>t["lg-regular"].lineHeight};
    letter-spacing: ${({typography:t})=>t["lg-regular"].letterSpacing};
    font-weight: ${({fontWeight:t})=>t.regular};
    font-family: ${({fontFamily:t})=>t.regular};
  }

  input[data-size='lg'] {
    padding: ${({spacing:t})=>t[4]} ${({spacing:t})=>t[3]}
      ${({spacing:t})=>t[4]} ${({spacing:t})=>t[10]};
  }

  @media (hover: hover) and (pointer: fine) {
    input:hover:enabled {
      border: 1px solid ${({tokens:t})=>t.theme.borderSecondary};
    }
  }

  input:disabled {
    cursor: unset;
    border: 1px solid ${({tokens:t})=>t.theme.borderPrimary};
  }

  input::placeholder {
    color: ${({tokens:t})=>t.theme.textSecondary};
  }

  input:focus:enabled {
    border: 1px solid ${({tokens:t})=>t.theme.borderSecondary};
    background-color: ${({tokens:t})=>t.theme.foregroundPrimary};
    -webkit-box-shadow: 0px 0px 0px 4px ${({tokens:t})=>t.core.foregroundAccent040};
    -moz-box-shadow: 0px 0px 0px 4px ${({tokens:t})=>t.core.foregroundAccent040};
    box-shadow: 0px 0px 0px 4px ${({tokens:t})=>t.core.foregroundAccent040};
  }

  div.wui-input-text-container:has(input:disabled) {
    opacity: 0.5;
  }

  wui-icon.wui-input-text-left-icon {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    pointer-events: none;
    left: ${({spacing:t})=>t[4]};
    color: ${({tokens:t})=>t.theme.iconDefault};
  }

  button.wui-input-text-submit-button {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    right: ${({spacing:t})=>t[3]};
    width: 24px;
    height: 24px;
    border: none;
    background: transparent;
    border-radius: ${({borderRadius:t})=>t[2]};
    color: ${({tokens:t})=>t.core.textAccentPrimary};
  }

  button.wui-input-text-submit-button:disabled {
    opacity: 1;
  }

  button.wui-input-text-submit-button.loading wui-icon {
    animation: spin 1s linear infinite;
  }

  button.wui-input-text-submit-button:hover {
    background: ${({tokens:t})=>t.core.foregroundAccent010};
  }

  input:has(+ .wui-input-text-submit-button) {
    padding-right: ${({spacing:t})=>t[12]};
  }

  input[type='number'] {
    -moz-appearance: textfield;
  }

  input[type='search']::-webkit-search-decoration,
  input[type='search']::-webkit-search-cancel-button,
  input[type='search']::-webkit-search-results-button,
  input[type='search']::-webkit-search-results-decoration {
    -webkit-appearance: none;
  }

  /* -- Keyframes --------------------------------------------------- */
  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }
`;var K=function(t,e,o,i){var n=arguments.length,r=n<3?e:i===null?i=Object.getOwnPropertyDescriptor(e,o):i,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")r=Reflect.decorate(t,e,o,i);else for(var l=t.length-1;l>=0;l--)(s=t[l])&&(r=(n<3?s(r):n>3?s(e,o,r):s(e,o))||r);return n>3&&r&&Object.defineProperty(e,o,r),r},q=class extends m{constructor(){super(...arguments),this.inputElementRef=je(),this.disabled=!1,this.loading=!1,this.placeholder="",this.type="text",this.value="",this.size="md"}render(){return c` <div class="wui-input-text-container">
        ${this.templateLeftIcon()}
        <input
          data-size=${this.size}
          ${qe(this.inputElementRef)}
          data-testid="wui-input-text"
          type=${this.type}
          enterkeyhint=${$(this.enterKeyHint)}
          ?disabled=${this.disabled}
          placeholder=${this.placeholder}
          @input=${this.dispatchInputChangeEvent.bind(this)}
          @keydown=${this.onKeyDown}
          .value=${this.value||""}
        />
        ${this.templateSubmitButton()}
        <slot class="wui-input-text-slot"></slot>
      </div>
      ${this.templateError()} ${this.templateWarning()}`}templateLeftIcon(){return this.icon?c`<wui-icon
        class="wui-input-text-left-icon"
        size="md"
        data-size=${this.size}
        color="inherit"
        name=${this.icon}
      ></wui-icon>`:null}templateSubmitButton(){return this.onSubmit?c`<button
        class="wui-input-text-submit-button ${this.loading?"loading":""}"
        @click=${this.onSubmit?.bind(this)}
        ?disabled=${this.disabled||this.loading}
      >
        ${this.loading?c`<wui-icon name="spinner" size="md"></wui-icon>`:c`<wui-icon name="chevronRight" size="md"></wui-icon>`}
      </button>`:null}templateError(){return this.errorText?c`<wui-text variant="sm-regular" color="error">${this.errorText}</wui-text>`:null}templateWarning(){return this.warningText?c`<wui-text variant="sm-regular" color="warning">${this.warningText}</wui-text>`:null}dispatchInputChangeEvent(){this.dispatchEvent(new CustomEvent("inputChange",{detail:this.inputElementRef.value?.value,bubbles:!0,composed:!0}))}};q.styles=[T,z,Gr];K([u()],q.prototype,"icon",void 0);K([u({type:Boolean})],q.prototype,"disabled",void 0);K([u({type:Boolean})],q.prototype,"loading",void 0);K([u()],q.prototype,"placeholder",void 0);K([u()],q.prototype,"type",void 0);K([u()],q.prototype,"value",void 0);K([u()],q.prototype,"errorText",void 0);K([u()],q.prototype,"warningText",void 0);K([u()],q.prototype,"onSubmit",void 0);K([u()],q.prototype,"size",void 0);K([u({attribute:!1})],q.prototype,"onKeyDown",void 0);q=K([p("wui-input-text")],q);var Qr=C`
  :host {
    position: relative;
    display: inline-block;
    width: 100%;
  }

  wui-icon {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    right: ${({spacing:t})=>t[3]};
    color: ${({tokens:t})=>t.theme.iconDefault};
    cursor: pointer;
    padding: ${({spacing:t})=>t[2]};
    background-color: transparent;
    border-radius: ${({borderRadius:t})=>t[4]};
    transition: background-color ${({durations:t})=>t.lg}
      ${({easings:t})=>t["ease-out-power-2"]};
  }

  @media (hover: hover) {
    wui-icon:hover {
      background-color: ${({tokens:t})=>t.theme.foregroundSecondary};
    }
  }
`;var Yr=function(t,e,o,i){var n=arguments.length,r=n<3?e:i===null?i=Object.getOwnPropertyDescriptor(e,o):i,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")r=Reflect.decorate(t,e,o,i);else for(var l=t.length-1;l>=0;l--)(s=t[l])&&(r=(n<3?s(r):n>3?s(e,o,r):s(e,o))||r);return n>3&&r&&Object.defineProperty(e,o,r),r},Wt=class extends m{constructor(){super(...arguments),this.inputComponentRef=je(),this.inputValue=""}render(){return c`
      <wui-input-text
        ${qe(this.inputComponentRef)}
        placeholder="Search wallet"
        icon="search"
        type="search"
        enterKeyHint="search"
        size="sm"
        @inputChange=${this.onInputChange}
      >
        ${this.inputValue?c`<wui-icon
              @click=${this.clearValue}
              color="inherit"
              size="sm"
              name="close"
            ></wui-icon>`:null}
      </wui-input-text>
    `}onInputChange(e){this.inputValue=e.detail||""}clearValue(){let o=this.inputComponentRef.value?.inputElementRef.value;o&&(o.value="",this.inputValue="",o.focus(),o.dispatchEvent(new Event("input")))}};Wt.styles=[T,Qr];Yr([u()],Wt.prototype,"inputValue",void 0);Wt=Yr([p("wui-search-bar")],Wt);var Jr=he`<svg  viewBox="0 0 48 54" fill="none">
  <path
    d="M43.4605 10.7248L28.0485 1.61089C25.5438 0.129705 22.4562 0.129705 19.9515 1.61088L4.53951 10.7248C2.03626 12.2051 0.5 14.9365 0.5 17.886V36.1139C0.5 39.0635 2.03626 41.7949 4.53951 43.2752L19.9515 52.3891C22.4562 53.8703 25.5438 53.8703 28.0485 52.3891L43.4605 43.2752C45.9637 41.7949 47.5 39.0635 47.5 36.114V17.8861C47.5 14.9365 45.9637 12.2051 43.4605 10.7248Z"
  />
</svg>`;var Xr=C`
  :host {
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    height: 104px;
    width: 104px;
    row-gap: ${({spacing:t})=>t[2]};
    background-color: ${({tokens:t})=>t.theme.foregroundPrimary};
    border-radius: ${({borderRadius:t})=>t[5]};
    position: relative;
  }

  wui-shimmer[data-type='network'] {
    border: none;
    -webkit-clip-path: var(--apkt-path-network);
    clip-path: var(--apkt-path-network);
  }

  svg {
    position: absolute;
    width: 48px;
    height: 54px;
    z-index: 1;
  }

  svg > path {
    stroke: ${({tokens:t})=>t.theme.foregroundSecondary};
    stroke-width: 1px;
  }

  @media (max-width: 350px) {
    :host {
      width: 100%;
    }
  }
`;var Zr=function(t,e,o,i){var n=arguments.length,r=n<3?e:i===null?i=Object.getOwnPropertyDescriptor(e,o):i,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")r=Reflect.decorate(t,e,o,i);else for(var l=t.length-1;l>=0;l--)(s=t[l])&&(r=(n<3?s(r):n>3?s(e,o,r):s(e,o))||r);return n>3&&r&&Object.defineProperty(e,o,r),r},Lt=class extends m{constructor(){super(...arguments),this.type="wallet"}render(){return c`
      ${this.shimmerTemplate()}
      <wui-shimmer width="80px" height="20px"></wui-shimmer>
    `}shimmerTemplate(){return this.type==="network"?c` <wui-shimmer data-type=${this.type} width="48px" height="54px"></wui-shimmer>
        ${Jr}`:c`<wui-shimmer width="56px" height="56px"></wui-shimmer>`}};Lt.styles=[T,z,Xr];Zr([u()],Lt.prototype,"type",void 0);Lt=Zr([p("wui-card-select-loader")],Lt);var ei=ct`
  :host {
    display: grid;
    width: inherit;
    height: inherit;
  }
`;var G=function(t,e,o,i){var n=arguments.length,r=n<3?e:i===null?i=Object.getOwnPropertyDescriptor(e,o):i,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")r=Reflect.decorate(t,e,o,i);else for(var l=t.length-1;l>=0;l--)(s=t[l])&&(r=(n<3?s(r):n>3?s(e,o,r):s(e,o))||r);return n>3&&r&&Object.defineProperty(e,o,r),r},F=class extends m{render(){return this.style.cssText=`
      grid-template-rows: ${this.gridTemplateRows};
      grid-template-columns: ${this.gridTemplateColumns};
      justify-items: ${this.justifyItems};
      align-items: ${this.alignItems};
      justify-content: ${this.justifyContent};
      align-content: ${this.alignContent};
      column-gap: ${this.columnGap&&`var(--apkt-spacing-${this.columnGap})`};
      row-gap: ${this.rowGap&&`var(--apkt-spacing-${this.rowGap})`};
      gap: ${this.gap&&`var(--apkt-spacing-${this.gap})`};
      padding-top: ${this.padding&&J.getSpacingStyles(this.padding,0)};
      padding-right: ${this.padding&&J.getSpacingStyles(this.padding,1)};
      padding-bottom: ${this.padding&&J.getSpacingStyles(this.padding,2)};
      padding-left: ${this.padding&&J.getSpacingStyles(this.padding,3)};
      margin-top: ${this.margin&&J.getSpacingStyles(this.margin,0)};
      margin-right: ${this.margin&&J.getSpacingStyles(this.margin,1)};
      margin-bottom: ${this.margin&&J.getSpacingStyles(this.margin,2)};
      margin-left: ${this.margin&&J.getSpacingStyles(this.margin,3)};
    `,c`<slot></slot>`}};F.styles=[T,ei];G([u()],F.prototype,"gridTemplateRows",void 0);G([u()],F.prototype,"gridTemplateColumns",void 0);G([u()],F.prototype,"justifyItems",void 0);G([u()],F.prototype,"alignItems",void 0);G([u()],F.prototype,"justifyContent",void 0);G([u()],F.prototype,"alignContent",void 0);G([u()],F.prototype,"columnGap",void 0);G([u()],F.prototype,"rowGap",void 0);G([u()],F.prototype,"gap",void 0);G([u()],F.prototype,"padding",void 0);G([u()],F.prototype,"margin",void 0);F=G([p("wui-grid")],F);var ti=C`
  button {
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    cursor: pointer;
    width: 104px;
    row-gap: ${({spacing:t})=>t[2]};
    padding: ${({spacing:t})=>t[3]} ${({spacing:t})=>t[0]};
    background-color: ${({tokens:t})=>t.theme.foregroundPrimary};
    border-radius: clamp(0px, ${({borderRadius:t})=>t[4]}, 20px);
    transition:
      color ${({durations:t})=>t.lg} ${({easings:t})=>t["ease-out-power-1"]},
      background-color ${({durations:t})=>t.lg}
        ${({easings:t})=>t["ease-out-power-1"]},
      border-radius ${({durations:t})=>t.lg}
        ${({easings:t})=>t["ease-out-power-1"]};
    will-change: background-color, color, border-radius;
    outline: none;
    border: none;
  }

  button > wui-flex > wui-text {
    color: ${({tokens:t})=>t.theme.textPrimary};
    max-width: 86px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    justify-content: center;
  }

  button > wui-flex > wui-text.certified {
    max-width: 66px;
  }

  @media (hover: hover) and (pointer: fine) {
    button:hover:enabled {
      background-color: ${({tokens:t})=>t.theme.foregroundSecondary};
    }
  }

  button:disabled > wui-flex > wui-text {
    color: ${({tokens:t})=>t.core.glass010};
  }

  [data-selected='true'] {
    background-color: ${({colors:t})=>t.accent020};
  }

  @media (hover: hover) and (pointer: fine) {
    [data-selected='true']:hover:enabled {
      background-color: ${({colors:t})=>t.accent010};
    }
  }

  [data-selected='true']:active:enabled {
    background-color: ${({colors:t})=>t.accent010};
  }

  @media (max-width: 350px) {
    button {
      width: 100%;
    }
  }
`;var te=function(t,e,o,i){var n=arguments.length,r=n<3?e:i===null?i=Object.getOwnPropertyDescriptor(e,o):i,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")r=Reflect.decorate(t,e,o,i);else for(var l=t.length-1;l>=0;l--)(s=t[l])&&(r=(n<3?s(r):n>3?s(e,o,r):s(e,o))||r);return n>3&&r&&Object.defineProperty(e,o,r),r},Q=class extends m{constructor(){super(),this.observer=new IntersectionObserver(()=>{}),this.visible=!1,this.imageSrc=void 0,this.imageLoading=!1,this.isImpressed=!1,this.explorerId="",this.walletQuery="",this.certified=!1,this.displayIndex=0,this.wallet=void 0,this.observer=new IntersectionObserver(e=>{e.forEach(o=>{o.isIntersecting?(this.visible=!0,this.fetchImageSrc(),this.sendImpressionEvent()):this.visible=!1})},{threshold:.01})}firstUpdated(){this.observer.observe(this)}disconnectedCallback(){this.observer.disconnect()}render(){let e=this.wallet?.badge_type==="certified";return c`
      <button>
        ${this.imageTemplate()}
        <wui-flex flexDirection="row" alignItems="center" justifyContent="center" gap="1">
          <wui-text
            variant="md-regular"
            color="inherit"
            class=${$(e?"certified":void 0)}
            >${this.wallet?.name}</wui-text
          >
          ${e?c`<wui-icon size="sm" name="walletConnectBrown"></wui-icon>`:null}
        </wui-flex>
      </button>
    `}imageTemplate(){return!this.visible&&!this.imageSrc||this.imageLoading?this.shimmerTemplate():c`
      <wui-wallet-image
        size="lg"
        imageSrc=${$(this.imageSrc)}
        name=${$(this.wallet?.name)}
        .installed=${this.wallet?.installed??!1}
        badgeSize="sm"
      >
      </wui-wallet-image>
    `}shimmerTemplate(){return c`<wui-shimmer width="56px" height="56px"></wui-shimmer>`}async fetchImageSrc(){this.wallet&&(this.imageSrc=V.getWalletImage(this.wallet),!this.imageSrc&&(this.imageLoading=!0,this.imageSrc=await V.fetchWalletImage(this.wallet.image_id),this.imageLoading=!1))}sendImpressionEvent(){!this.wallet||this.isImpressed||(this.isImpressed=!0,W.sendWalletImpressionEvent({name:this.wallet.name,walletRank:this.wallet.order,explorerId:this.explorerId,view:f.state.view,query:this.walletQuery,certified:this.certified,displayIndex:this.displayIndex}))}};Q.styles=ti;te([h()],Q.prototype,"visible",void 0);te([h()],Q.prototype,"imageSrc",void 0);te([h()],Q.prototype,"imageLoading",void 0);te([h()],Q.prototype,"isImpressed",void 0);te([u()],Q.prototype,"explorerId",void 0);te([u()],Q.prototype,"walletQuery",void 0);te([u()],Q.prototype,"certified",void 0);te([u()],Q.prototype,"displayIndex",void 0);te([u({type:Object})],Q.prototype,"wallet",void 0);Q=te([p("w3m-all-wallets-list-item")],Q);var oi=C`
  wui-grid {
    max-height: clamp(360px, 400px, 80vh);
    overflow: scroll;
    scrollbar-width: none;
    grid-auto-rows: min-content;
    grid-template-columns: repeat(auto-fill, 104px);
  }

  :host([data-mobile-fullscreen='true']) wui-grid {
    max-height: none;
  }

  @media (max-width: 350px) {
    wui-grid {
      grid-template-columns: repeat(2, 1fr);
    }
  }

  wui-grid[data-scroll='false'] {
    overflow: hidden;
  }

  wui-grid::-webkit-scrollbar {
    display: none;
  }

  w3m-all-wallets-list-item {
    opacity: 0;
    animation-duration: ${({durations:t})=>t.xl};
    animation-timing-function: ${({easings:t})=>t["ease-inout-power-2"]};
    animation-name: fade-in;
    animation-fill-mode: forwards;
  }

  @keyframes fade-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  wui-loading-spinner {
    padding-top: ${({spacing:t})=>t[4]};
    padding-bottom: ${({spacing:t})=>t[4]};
    justify-content: center;
    grid-column: 1 / span 4;
  }
`;var ye=function(t,e,o,i){var n=arguments.length,r=n<3?e:i===null?i=Object.getOwnPropertyDescriptor(e,o):i,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")r=Reflect.decorate(t,e,o,i);else for(var l=t.length-1;l>=0;l--)(s=t[l])&&(r=(n<3?s(r):n>3?s(e,o,r):s(e,o))||r);return n>3&&r&&Object.defineProperty(e,o,r),r},ri="local-paginator",oe=class extends m{constructor(){super(),this.unsubscribe=[],this.paginationObserver=void 0,this.loading=!v.state.wallets.length,this.wallets=v.state.wallets,this.recommended=v.state.recommended,this.featured=v.state.featured,this.filteredWallets=v.state.filteredWallets,this.mobileFullScreen=N.state.enableMobileFullScreen,this.unsubscribe.push(v.subscribeKey("wallets",e=>this.wallets=e),v.subscribeKey("recommended",e=>this.recommended=e),v.subscribeKey("featured",e=>this.featured=e),v.subscribeKey("filteredWallets",e=>this.filteredWallets=e))}firstUpdated(){this.initialFetch(),this.createPaginationObserver()}disconnectedCallback(){this.unsubscribe.forEach(e=>e()),this.paginationObserver?.disconnect()}render(){return this.mobileFullScreen&&this.setAttribute("data-mobile-fullscreen","true"),c`
      <wui-grid
        data-scroll=${!this.loading}
        .padding=${["0","3","3","3"]}
        gap="2"
        justifyContent="space-between"
      >
        ${this.loading?this.shimmerTemplate(16):this.walletsTemplate()}
        ${this.paginationLoaderTemplate()}
      </wui-grid>
    `}async initialFetch(){this.loading=!0;let e=this.shadowRoot?.querySelector("wui-grid");e&&(await v.fetchWalletsByPage({page:1}),await e.animate([{opacity:1},{opacity:0}],{duration:200,fill:"forwards",easing:"ease"}).finished,this.loading=!1,e.animate([{opacity:0},{opacity:1}],{duration:200,fill:"forwards",easing:"ease"}))}shimmerTemplate(e,o){return[...Array(e)].map(()=>c`
        <wui-card-select-loader type="wallet" id=${$(o)}></wui-card-select-loader>
      `)}getWallets(){let e=[...this.featured,...this.recommended];this.filteredWallets?.length>0?e.push(...this.filteredWallets):e.push(...this.wallets);let o=w.uniqueBy(e,"id"),i=He.markWalletsAsInstalled(o);return He.markWalletsWithDisplayIndex(i)}walletsTemplate(){return this.getWallets().map((o,i)=>c`
        <w3m-all-wallets-list-item
          data-testid="wallet-search-item-${o.id}"
          @click=${()=>this.onConnectWallet(o)}
          .wallet=${o}
          explorerId=${o.id}
          certified=${this.badge==="certified"}
          displayIndex=${i}
        ></w3m-all-wallets-list-item>
      `)}paginationLoaderTemplate(){let{wallets:e,recommended:o,featured:i,count:n,mobileFilteredOutWalletsLength:r}=v.state,s=window.innerWidth<352?3:4,l=e.length+o.length,d=Math.ceil(l/s)*s-l+s;return d-=e.length?i.length%s:0,n===0&&i.length>0?null:n===0||[...i,...e,...o].length<n-(r??0)?this.shimmerTemplate(d,ri):null}createPaginationObserver(){let e=this.shadowRoot?.querySelector(`#${ri}`);e&&(this.paginationObserver=new IntersectionObserver(([o])=>{if(o?.isIntersecting&&!this.loading){let{page:i,count:n,wallets:r}=v.state;r.length<n&&v.fetchWalletsByPage({page:i+1})}}),this.paginationObserver.observe(e))}onConnectWallet(e){U.selectWalletConnector(e)}};oe.styles=oi;ye([h()],oe.prototype,"loading",void 0);ye([h()],oe.prototype,"wallets",void 0);ye([h()],oe.prototype,"recommended",void 0);ye([h()],oe.prototype,"featured",void 0);ye([h()],oe.prototype,"filteredWallets",void 0);ye([h()],oe.prototype,"badge",void 0);ye([h()],oe.prototype,"mobileFullScreen",void 0);oe=ye([p("w3m-all-wallets-list")],oe);var ii=ct`
  wui-grid,
  wui-loading-spinner,
  wui-flex {
    height: 360px;
  }

  wui-grid {
    overflow: scroll;
    scrollbar-width: none;
    grid-auto-rows: min-content;
    grid-template-columns: repeat(auto-fill, 104px);
  }

  :host([data-mobile-fullscreen='true']) wui-grid {
    max-height: none;
    height: auto;
  }

  wui-grid[data-scroll='false'] {
    overflow: hidden;
  }

  wui-grid::-webkit-scrollbar {
    display: none;
  }

  wui-loading-spinner {
    justify-content: center;
    align-items: center;
  }

  @media (max-width: 350px) {
    wui-grid {
      grid-template-columns: repeat(2, 1fr);
    }
  }
`;var it=function(t,e,o,i){var n=arguments.length,r=n<3?e:i===null?i=Object.getOwnPropertyDescriptor(e,o):i,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")r=Reflect.decorate(t,e,o,i);else for(var l=t.length-1;l>=0;l--)(s=t[l])&&(r=(n<3?s(r):n>3?s(e,o,r):s(e,o))||r);return n>3&&r&&Object.defineProperty(e,o,r),r},We=class extends m{constructor(){super(...arguments),this.prevQuery="",this.prevBadge=void 0,this.loading=!0,this.mobileFullScreen=N.state.enableMobileFullScreen,this.query=""}render(){return this.mobileFullScreen&&this.setAttribute("data-mobile-fullscreen","true"),this.onSearch(),this.loading?c`<wui-loading-spinner color="accent-primary"></wui-loading-spinner>`:this.walletsTemplate()}async onSearch(){(this.query.trim()!==this.prevQuery.trim()||this.badge!==this.prevBadge)&&(this.prevQuery=this.query,this.prevBadge=this.badge,this.loading=!0,await v.searchWallet({search:this.query,badge:this.badge}),this.loading=!1)}walletsTemplate(){let{search:e}=v.state,o=He.markWalletsAsInstalled(e);return e.length?c`
      <wui-grid
        data-testid="wallet-list"
        .padding=${["0","3","3","3"]}
        rowGap="4"
        columngap="2"
        justifyContent="space-between"
      >
        ${o.map((i,n)=>c`
            <w3m-all-wallets-list-item
              @click=${()=>this.onConnectWallet(i)}
              .wallet=${i}
              data-testid="wallet-search-item-${i.id}"
              explorerId=${i.id}
              certified=${this.badge==="certified"}
              walletQuery=${this.query}
              displayIndex=${n}
            ></w3m-all-wallets-list-item>
          `)}
      </wui-grid>
    `:c`
        <wui-flex
          data-testid="no-wallet-found"
          justifyContent="center"
          alignItems="center"
          gap="3"
          flexDirection="column"
        >
          <wui-icon-box size="lg" color="default" icon="wallet"></wui-icon-box>
          <wui-text data-testid="no-wallet-found-text" color="secondary" variant="md-medium">
            No Wallet found
          </wui-text>
        </wui-flex>
      `}onConnectWallet(e){U.selectWalletConnector(e)}};We.styles=ii;it([h()],We.prototype,"loading",void 0);it([h()],We.prototype,"mobileFullScreen",void 0);it([u()],We.prototype,"query",void 0);it([u()],We.prototype,"badge",void 0);We=it([p("w3m-all-wallets-search")],We);var ho=function(t,e,o,i){var n=arguments.length,r=n<3?e:i===null?i=Object.getOwnPropertyDescriptor(e,o):i,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")r=Reflect.decorate(t,e,o,i);else for(var l=t.length-1;l>=0;l--)(s=t[l])&&(r=(n<3?s(r):n>3?s(e,o,r):s(e,o))||r);return n>3&&r&&Object.defineProperty(e,o,r),r},kt=class extends m{constructor(){super(...arguments),this.search="",this.badge=void 0,this.onDebouncedSearch=w.debounce(e=>{this.search=e})}render(){let e=this.search.length>=2;return c`
      <wui-flex .padding=${["1","3","3","3"]} gap="2" alignItems="center">
        <wui-search-bar @inputChange=${this.onInputChange.bind(this)}></wui-search-bar>
        <wui-certified-switch
          ?checked=${this.badge==="certified"}
          @certifiedSwitchChange=${this.onCertifiedSwitchChange.bind(this)}
          data-testid="wui-certified-switch"
        ></wui-certified-switch>
        ${this.qrButtonTemplate()}
      </wui-flex>
      ${e||this.badge?c`<w3m-all-wallets-search
            query=${this.search}
            .badge=${this.badge}
          ></w3m-all-wallets-search>`:c`<w3m-all-wallets-list .badge=${this.badge}></w3m-all-wallets-list>`}
    `}onInputChange(e){this.onDebouncedSearch(e.detail)}onCertifiedSwitchChange(e){e.detail?(this.badge="certified",de.showSvg("Only WalletConnect certified",{icon:"walletConnectBrown",iconColor:"accent-100"})):this.badge=void 0}qrButtonTemplate(){return w.isMobile()?c`
        <wui-icon-box
          size="xl"
          iconSize="xl"
          color="accent-primary"
          icon="qrCode"
          border
          borderColor="wui-accent-glass-010"
          @click=${this.onWalletConnectQr.bind(this)}
        ></wui-icon-box>
      `:null}onWalletConnectQr(){f.push("ConnectingWalletConnect")}};ho([h()],kt.prototype,"search",void 0);ho([h()],kt.prototype,"badge",void 0);kt=ho([p("w3m-all-wallets-view")],kt);var ni=C`
  :host {
    width: 100%;
  }

  button {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: ${({spacing:t})=>t[3]};
    width: 100%;
    background-color: ${({tokens:t})=>t.theme.backgroundPrimary};
    border-radius: ${({borderRadius:t})=>t[4]};
    transition:
      background-color ${({durations:t})=>t.lg}
        ${({easings:t})=>t["ease-out-power-2"]},
      scale ${({durations:t})=>t.lg} ${({easings:t})=>t["ease-out-power-2"]};
    will-change: background-color, scale;
  }

  wui-text {
    text-transform: capitalize;
  }

  wui-image {
    color: ${({tokens:t})=>t.theme.textPrimary};
  }

  @media (hover: hover) {
    button:hover:enabled {
      background-color: ${({tokens:t})=>t.theme.foregroundPrimary};
    }
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;var re=function(t,e,o,i){var n=arguments.length,r=n<3?e:i===null?i=Object.getOwnPropertyDescriptor(e,o):i,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")r=Reflect.decorate(t,e,o,i);else for(var l=t.length-1;l>=0;l--)(s=t[l])&&(r=(n<3?s(r):n>3?s(e,o,r):s(e,o))||r);return n>3&&r&&Object.defineProperty(e,o,r),r},Y=class extends m{constructor(){super(...arguments),this.imageSrc="google",this.loading=!1,this.disabled=!1,this.rightIcon=!0,this.rounded=!1,this.fullSize=!1}render(){return this.dataset.rounded=this.rounded?"true":"false",c`
      <button
        ?disabled=${this.loading?!0:!!this.disabled}
        data-loading=${this.loading}
        tabindex=${$(this.tabIdx)}
      >
        <wui-flex gap="2" alignItems="center">
          ${this.templateLeftIcon()}
          <wui-flex gap="1">
            <slot></slot>
          </wui-flex>
        </wui-flex>
        ${this.templateRightIcon()}
      </button>
    `}templateLeftIcon(){return this.icon?c`<wui-image
        icon=${this.icon}
        iconColor=${$(this.iconColor)}
        ?boxed=${!0}
        ?rounded=${this.rounded}
      ></wui-image>`:c`<wui-image
      ?boxed=${!0}
      ?rounded=${this.rounded}
      ?fullSize=${this.fullSize}
      src=${this.imageSrc}
    ></wui-image>`}templateRightIcon(){return this.rightIcon?this.loading?c`<wui-loading-spinner size="md" color="accent-primary"></wui-loading-spinner>`:c`<wui-icon name="chevronRight" size="lg" color="default"></wui-icon>`:null}};Y.styles=[T,z,ni];re([u()],Y.prototype,"imageSrc",void 0);re([u()],Y.prototype,"icon",void 0);re([u()],Y.prototype,"iconColor",void 0);re([u({type:Boolean})],Y.prototype,"loading",void 0);re([u()],Y.prototype,"tabIdx",void 0);re([u({type:Boolean})],Y.prototype,"disabled",void 0);re([u({type:Boolean})],Y.prototype,"rightIcon",void 0);re([u({type:Boolean})],Y.prototype,"rounded",void 0);re([u({type:Boolean})],Y.prototype,"fullSize",void 0);Y=re([p("wui-list-item")],Y);var gn=function(t,e,o,i){var n=arguments.length,r=n<3?e:i===null?i=Object.getOwnPropertyDescriptor(e,o):i,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")r=Reflect.decorate(t,e,o,i);else for(var l=t.length-1;l>=0;l--)(s=t[l])&&(r=(n<3?s(r):n>3?s(e,o,r):s(e,o))||r);return n>3&&r&&Object.defineProperty(e,o,r),r},si=class extends m{constructor(){super(...arguments),this.wallet=f.state.data?.wallet}render(){if(!this.wallet)throw new Error("w3m-downloads-view");return c`
      <wui-flex gap="2" flexDirection="column" .padding=${["3","3","4","3"]}>
        ${this.chromeTemplate()} ${this.iosTemplate()} ${this.androidTemplate()}
        ${this.homepageTemplate()}
      </wui-flex>
    `}chromeTemplate(){return this.wallet?.chrome_store?c`<wui-list-item
      variant="icon"
      icon="chromeStore"
      iconVariant="square"
      @click=${this.onChromeStore.bind(this)}
      chevron
    >
      <wui-text variant="md-medium" color="primary">Chrome Extension</wui-text>
    </wui-list-item>`:null}iosTemplate(){return this.wallet?.app_store?c`<wui-list-item
      variant="icon"
      icon="appStore"
      iconVariant="square"
      @click=${this.onAppStore.bind(this)}
      chevron
    >
      <wui-text variant="md-medium" color="primary">iOS App</wui-text>
    </wui-list-item>`:null}androidTemplate(){return this.wallet?.play_store?c`<wui-list-item
      variant="icon"
      icon="playStore"
      iconVariant="square"
      @click=${this.onPlayStore.bind(this)}
      chevron
    >
      <wui-text variant="md-medium" color="primary">Android App</wui-text>
    </wui-list-item>`:null}homepageTemplate(){return this.wallet?.homepage?c`
      <wui-list-item
        variant="icon"
        icon="browser"
        iconVariant="square-blue"
        @click=${this.onHomePage.bind(this)}
        chevron
      >
        <wui-text variant="md-medium" color="primary">Website</wui-text>
      </wui-list-item>
    `:null}openStore(e){e.href&&this.wallet&&(W.sendEvent({type:"track",event:"GET_WALLET",properties:{name:this.wallet.name,walletRank:this.wallet.order,explorerId:this.wallet.id,type:e.type}}),w.openHref(e.href,"_blank"))}onChromeStore(){this.wallet?.chrome_store&&this.openStore({href:this.wallet.chrome_store,type:"chrome_store"})}onAppStore(){this.wallet?.app_store&&this.openStore({href:this.wallet.app_store,type:"app_store"})}onPlayStore(){this.wallet?.play_store&&this.openStore({href:this.wallet.play_store,type:"play_store"})}onHomePage(){this.wallet?.homepage&&this.openStore({href:this.wallet.homepage,type:"homepage"})}};si=gn([p("w3m-downloads-view")],si);export{kt as W3mAllWalletsView,St as W3mConnectingWcBasicView,si as W3mDownloadsView};
/*! Bundled license information:

lit-html/directive-helpers.js:
lit-html/directives/ref.js:
  (**
   * @license
   * Copyright 2020 Google LLC
   * SPDX-License-Identifier: BSD-3-Clause
   *)

lit-html/async-directive.js:
  (**
   * @license
   * Copyright 2017 Google LLC
   * SPDX-License-Identifier: BSD-3-Clause
   *)
*/
