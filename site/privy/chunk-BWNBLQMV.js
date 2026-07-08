import{a as c,b as p,c as b}from"./chunk-LDGUG64X.js";import{A as C,B as ee,C as te,D as m,c as D,d as ye,e as B,i as Z,j as J,k as P,l as Q,o as n,u,v as L,w as h,x as xe}from"./chunk-6UZQFM3U.js";import{A as q,B as R,C as j,D as d,E as be,F,H as ve,P as g,Q as O,a as G,d as he,r as we,t as w,u as A,w as fe,z as ge}from"./chunk-M3IQZ5LR.js";import"./chunk-EFK6JAUM.js";import"./chunk-JVFQFJH5.js";import"./chunk-VHIR2IYC.js";import"./chunk-LYIDHH4Z.js";import"./chunk-JTYV7RXW.js";import"./chunk-3IKZH76S.js";var Ce=h`
  :host {
    display: block;
    border-radius: clamp(0px, ${({borderRadius:e})=>e[8]}, 44px);
    box-shadow: 0 0 0 1px ${({tokens:e})=>e.theme.foregroundPrimary};
    overflow: hidden;
  }
`;var Ge=function(e,t,o,r){var a=arguments.length,i=a<3?t:r===null?r=Object.getOwnPropertyDescriptor(t,o):r,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")i=Reflect.decorate(e,t,o,r);else for(var l=e.length-1;l>=0;l--)(s=e[l])&&(i=(a<3?s(i):a>3?s(t,o,i):s(t,o))||i);return a>3&&i&&Object.defineProperty(t,o,i),i},le=class extends u{render(){return n`<slot></slot>`}};le.styles=[C,Ce];le=Ge([m("wui-card")],le);var ke=h`
  :host {
    width: 100%;
  }

  :host > wui-flex {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: ${({spacing:e})=>e[2]};
    padding: ${({spacing:e})=>e[3]};
    border-radius: ${({borderRadius:e})=>e[6]};
    border: 1px solid ${({tokens:e})=>e.theme.borderPrimary};
    box-sizing: border-box;
    background-color: ${({tokens:e})=>e.theme.foregroundPrimary};
    box-shadow: 0px 0px 16px 0px rgba(0, 0, 0, 0.25);
    color: ${({tokens:e})=>e.theme.textPrimary};
  }

  :host > wui-flex[data-type='info'] {
    .icon-box {
      background-color: ${({tokens:e})=>e.theme.foregroundSecondary};

      wui-icon {
        color: ${({tokens:e})=>e.theme.iconDefault};
      }
    }
  }
  :host > wui-flex[data-type='success'] {
    .icon-box {
      background-color: ${({tokens:e})=>e.core.backgroundSuccess};

      wui-icon {
        color: ${({tokens:e})=>e.core.borderSuccess};
      }
    }
  }
  :host > wui-flex[data-type='warning'] {
    .icon-box {
      background-color: ${({tokens:e})=>e.core.backgroundWarning};

      wui-icon {
        color: ${({tokens:e})=>e.core.borderWarning};
      }
    }
  }
  :host > wui-flex[data-type='error'] {
    .icon-box {
      background-color: ${({tokens:e})=>e.core.backgroundError};

      wui-icon {
        color: ${({tokens:e})=>e.core.borderError};
      }
    }
  }

  wui-flex {
    width: 100%;
  }

  wui-text {
    word-break: break-word;
    flex: 1;
  }

  .close {
    cursor: pointer;
    color: ${({tokens:e})=>e.theme.iconDefault};
  }

  .icon-box {
    height: 40px;
    width: 40px;
    border-radius: ${({borderRadius:e})=>e[2]};
    background-color: var(--local-icon-bg-value);
  }
`;var ce=function(e,t,o,r){var a=arguments.length,i=a<3?t:r===null?r=Object.getOwnPropertyDescriptor(t,o):r,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")i=Reflect.decorate(e,t,o,r);else for(var l=e.length-1;l>=0;l--)(s=e[l])&&(i=(a<3?s(i):a>3?s(t,o,i):s(t,o))||i);return a>3&&i&&Object.defineProperty(t,o,i),i},qe={info:"info",success:"checkmark",warning:"warningCircle",error:"warning"},V=class extends u{constructor(){super(...arguments),this.message="",this.type="info"}render(){return n`
      <wui-flex
        data-type=${b(this.type)}
        flexDirection="row"
        justifyContent="space-between"
        alignItems="center"
        gap="2"
      >
        <wui-flex columnGap="2" flexDirection="row" alignItems="center">
          <wui-flex
            flexDirection="row"
            alignItems="center"
            justifyContent="center"
            class="icon-box"
          >
            <wui-icon color="inherit" size="md" name=${qe[this.type]}></wui-icon>
          </wui-flex>
          <wui-text variant="md-medium" color="inherit" data-testid="wui-alertbar-text"
            >${this.message}</wui-text
          >
        </wui-flex>
        <wui-icon
          class="close"
          color="inherit"
          size="sm"
          name="close"
          @click=${this.onClose}
        ></wui-icon>
      </wui-flex>
    `}onClose(){D.close()}};V.styles=[C,ke];ce([c()],V.prototype,"message",void 0);ce([c()],V.prototype,"type",void 0);V=ce([m("wui-alertbar")],V);var $e=h`
  :host {
    display: block;
    position: absolute;
    top: ${({spacing:e})=>e[3]};
    left: ${({spacing:e})=>e[4]};
    right: ${({spacing:e})=>e[4]};
    opacity: 0;
    pointer-events: none;
  }
`;var Se=function(e,t,o,r){var a=arguments.length,i=a<3?t:r===null?r=Object.getOwnPropertyDescriptor(t,o):r,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")i=Reflect.decorate(e,t,o,r);else for(var l=e.length-1;l>=0;l--)(s=e[l])&&(i=(a<3?s(i):a>3?s(t,o,i):s(t,o))||i);return a>3&&i&&Object.defineProperty(t,o,i),i},Ze={info:{backgroundColor:"fg-350",iconColor:"fg-325",icon:"info"},success:{backgroundColor:"success-glass-reown-020",iconColor:"success-125",icon:"checkmark"},warning:{backgroundColor:"warning-glass-reown-020",iconColor:"warning-100",icon:"warningCircle"},error:{backgroundColor:"error-glass-reown-020",iconColor:"error-125",icon:"warning"}},oe=class extends u{constructor(){super(),this.unsubscribe=[],this.open=D.state.open,this.onOpen(!0),this.unsubscribe.push(D.subscribeKey("open",t=>{this.open=t,this.onOpen(!1)}))}disconnectedCallback(){this.unsubscribe.forEach(t=>t())}render(){let{message:t,variant:o}=D.state,r=Ze[o];return n`
      <wui-alertbar
        message=${t}
        backgroundColor=${r?.backgroundColor}
        iconColor=${r?.iconColor}
        icon=${r?.icon}
        type=${o}
      ></wui-alertbar>
    `}onOpen(t){this.open?(this.animate([{opacity:0,transform:"scale(0.85)"},{opacity:1,transform:"scale(1)"}],{duration:150,fill:"forwards",easing:"ease"}),this.style.cssText="pointer-events: auto"):t||(this.animate([{opacity:1,transform:"scale(1)"},{opacity:0,transform:"scale(0.85)"}],{duration:150,fill:"forwards",easing:"ease"}),this.style.cssText="pointer-events: none")}};oe.styles=$e;Se([p()],oe.prototype,"open",void 0);oe=Se([m("w3m-alertbar")],oe);var Ee=h`
  :host {
    position: relative;
  }

  button {
    display: flex;
    justify-content: center;
    align-items: center;
    background-color: transparent;
    padding: ${({spacing:e})=>e[1]};
  }

  /* -- Colors --------------------------------------------------- */
  button[data-type='accent'] wui-icon {
    color: ${({tokens:e})=>e.core.iconAccentPrimary};
  }

  button[data-type='neutral'][data-variant='primary'] wui-icon {
    color: ${({tokens:e})=>e.theme.iconInverse};
  }

  button[data-type='neutral'][data-variant='secondary'] wui-icon {
    color: ${({tokens:e})=>e.theme.iconDefault};
  }

  button[data-type='success'] wui-icon {
    color: ${({tokens:e})=>e.core.iconSuccess};
  }

  button[data-type='error'] wui-icon {
    color: ${({tokens:e})=>e.core.iconError};
  }

  /* -- Sizes --------------------------------------------------- */
  button[data-size='xs'] {
    width: 16px;
    height: 16px;

    border-radius: ${({borderRadius:e})=>e[1]};
  }

  button[data-size='sm'] {
    width: 20px;
    height: 20px;
    border-radius: ${({borderRadius:e})=>e[1]};
  }

  button[data-size='md'] {
    width: 24px;
    height: 24px;
    border-radius: ${({borderRadius:e})=>e[2]};
  }

  button[data-size='lg'] {
    width: 28px;
    height: 28px;
    border-radius: ${({borderRadius:e})=>e[2]};
  }

  button[data-size='xs'] wui-icon {
    width: 8px;
    height: 8px;
  }

  button[data-size='sm'] wui-icon {
    width: 12px;
    height: 12px;
  }

  button[data-size='md'] wui-icon {
    width: 16px;
    height: 16px;
  }

  button[data-size='lg'] wui-icon {
    width: 20px;
    height: 20px;
  }

  /* -- Hover --------------------------------------------------- */
  @media (hover: hover) {
    button[data-type='accent']:hover:enabled {
      background-color: ${({tokens:e})=>e.core.foregroundAccent010};
    }

    button[data-variant='primary'][data-type='neutral']:hover:enabled {
      background-color: ${({tokens:e})=>e.theme.foregroundSecondary};
    }

    button[data-variant='secondary'][data-type='neutral']:hover:enabled {
      background-color: ${({tokens:e})=>e.theme.foregroundSecondary};
    }

    button[data-type='success']:hover:enabled {
      background-color: ${({tokens:e})=>e.core.backgroundSuccess};
    }

    button[data-type='error']:hover:enabled {
      background-color: ${({tokens:e})=>e.core.backgroundError};
    }
  }

  /* -- Focus --------------------------------------------------- */
  button:focus-visible {
    box-shadow: 0 0 0 4px ${({tokens:e})=>e.core.foregroundAccent020};
  }

  /* -- Properties --------------------------------------------------- */
  button[data-full-width='true'] {
    width: 100%;
  }

  :host([fullWidth]) {
    width: 100%;
  }

  button[disabled] {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;var I=function(e,t,o,r){var a=arguments.length,i=a<3?t:r===null?r=Object.getOwnPropertyDescriptor(t,o):r,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")i=Reflect.decorate(e,t,o,r);else for(var l=e.length-1;l>=0;l--)(s=e[l])&&(i=(a<3?s(i):a>3?s(t,o,i):s(t,o))||i);return a>3&&i&&Object.defineProperty(t,o,i),i},k=class extends u{constructor(){super(...arguments),this.icon="card",this.variant="primary",this.type="accent",this.size="md",this.iconSize=void 0,this.fullWidth=!1,this.disabled=!1}render(){return n`<button
      data-variant=${this.variant}
      data-type=${this.type}
      data-size=${this.size}
      data-full-width=${this.fullWidth}
      ?disabled=${this.disabled}
    >
      <wui-icon color="inherit" name=${this.icon} size=${b(this.iconSize)}></wui-icon>
    </button>`}};k.styles=[C,ee,Ee];I([c()],k.prototype,"icon",void 0);I([c()],k.prototype,"variant",void 0);I([c()],k.prototype,"type",void 0);I([c()],k.prototype,"size",void 0);I([c()],k.prototype,"iconSize",void 0);I([c({type:Boolean})],k.prototype,"fullWidth",void 0);I([c({type:Boolean})],k.prototype,"disabled",void 0);k=I([m("wui-icon-button")],k);var We=h`
  button {
    display: block;
    display: flex;
    align-items: center;
    padding: ${({spacing:e})=>e[1]};
    transition: background-color ${({durations:e})=>e.lg}
      ${({easings:e})=>e["ease-out-power-2"]};
    will-change: background-color;
    border-radius: ${({borderRadius:e})=>e[32]};
  }

  wui-image {
    border-radius: 100%;
  }

  wui-text {
    padding-left: ${({spacing:e})=>e[1]};
  }

  .left-icon-container,
  .right-icon-container {
    width: 24px;
    height: 24px;
    justify-content: center;
    align-items: center;
  }

  wui-icon {
    color: ${({tokens:e})=>e.theme.iconDefault};
  }

  /* -- Sizes --------------------------------------------------- */
  button[data-size='lg'] {
    height: 32px;
  }

  button[data-size='md'] {
    height: 28px;
  }

  button[data-size='sm'] {
    height: 24px;
  }

  button[data-size='lg'] wui-image {
    width: 24px;
    height: 24px;
  }

  button[data-size='md'] wui-image {
    width: 20px;
    height: 20px;
  }

  button[data-size='sm'] wui-image {
    width: 16px;
    height: 16px;
  }

  button[data-size='lg'] .left-icon-container {
    width: 24px;
    height: 24px;
  }

  button[data-size='md'] .left-icon-container {
    width: 20px;
    height: 20px;
  }

  button[data-size='sm'] .left-icon-container {
    width: 16px;
    height: 16px;
  }

  /* -- Variants --------------------------------------------------------- */
  button[data-type='filled-dropdown'] {
    background-color: ${({tokens:e})=>e.theme.foregroundPrimary};
  }

  button[data-type='text-dropdown'] {
    background-color: transparent;
  }

  /* -- Focus states --------------------------------------------------- */
  button:focus-visible:enabled {
    background-color: ${({tokens:e})=>e.theme.foregroundSecondary};
    box-shadow: 0 0 0 4px ${({tokens:e})=>e.core.foregroundAccent040};
  }

  /* -- Hover & Active states ----------------------------------------------------------- */
  @media (hover: hover) and (pointer: fine) {
    button:hover:enabled,
    button:active:enabled {
      background-color: ${({tokens:e})=>e.theme.foregroundSecondary};
    }
  }

  /* -- Disabled states --------------------------------------------------- */
  button:disabled {
    background-color: ${({tokens:e})=>e.theme.foregroundSecondary};
    opacity: 0.5;
  }
`;var H=function(e,t,o,r){var a=arguments.length,i=a<3?t:r===null?r=Object.getOwnPropertyDescriptor(t,o):r,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")i=Reflect.decorate(e,t,o,r);else for(var l=e.length-1;l>=0;l--)(s=e[l])&&(i=(a<3?s(i):a>3?s(t,o,i):s(t,o))||i);return a>3&&i&&Object.defineProperty(t,o,i),i},Je={lg:"lg-regular",md:"md-regular",sm:"sm-regular"},Qe={lg:"lg",md:"md",sm:"sm"},N=class extends u{constructor(){super(...arguments),this.imageSrc="",this.text="",this.size="lg",this.type="text-dropdown",this.disabled=!1}render(){return n`<button ?disabled=${this.disabled} data-size=${this.size} data-type=${this.type}>
      ${this.imageTemplate()} ${this.textTemplate()}
      <wui-flex class="right-icon-container">
        <wui-icon name="chevronBottom"></wui-icon>
      </wui-flex>
    </button>`}textTemplate(){let t=Je[this.size];return this.text?n`<wui-text color="primary" variant=${t}>${this.text}</wui-text>`:null}imageTemplate(){if(this.imageSrc)return n`<wui-image src=${this.imageSrc} alt="select visual"></wui-image>`;let t=Qe[this.size];return n` <wui-flex class="left-icon-container">
      <wui-icon size=${t} name="networkPlaceholder"></wui-icon>
    </wui-flex>`}};N.styles=[C,ee,We];H([c()],N.prototype,"imageSrc",void 0);H([c()],N.prototype,"text",void 0);H([c()],N.prototype,"size",void 0);H([c()],N.prototype,"type",void 0);H([c({type:Boolean})],N.prototype,"disabled",void 0);N=H([m("wui-select")],N);var Re=h`
  :host {
    height: 60px;
  }

  :host > wui-flex {
    box-sizing: border-box;
    background-color: var(--local-header-background-color);
  }

  wui-text {
    background-color: var(--local-header-background-color);
  }

  wui-flex.w3m-header-title {
    transform: translateY(0);
    opacity: 1;
  }

  wui-flex.w3m-header-title[view-direction='prev'] {
    animation:
      slide-down-out 120ms forwards ${({easings:e})=>e["ease-out-power-2"]},
      slide-down-in 120ms forwards ${({easings:e})=>e["ease-out-power-2"]};
    animation-delay: 0ms, 200ms;
  }

  wui-flex.w3m-header-title[view-direction='next'] {
    animation:
      slide-up-out 120ms forwards ${({easings:e})=>e["ease-out-power-2"]},
      slide-up-in 120ms forwards ${({easings:e})=>e["ease-out-power-2"]};
    animation-delay: 0ms, 200ms;
  }

  wui-icon-button[data-hidden='true'] {
    opacity: 0 !important;
    pointer-events: none;
  }

  @keyframes slide-up-out {
    from {
      transform: translateY(0px);
      opacity: 1;
    }
    to {
      transform: translateY(3px);
      opacity: 0;
    }
  }

  @keyframes slide-up-in {
    from {
      transform: translateY(-3px);
      opacity: 0;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }

  @keyframes slide-down-out {
    from {
      transform: translateY(0px);
      opacity: 1;
    }
    to {
      transform: translateY(-3px);
      opacity: 0;
    }
  }

  @keyframes slide-down-in {
    from {
      transform: translateY(3px);
      opacity: 0;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }
`;var T=function(e,t,o,r){var a=arguments.length,i=a<3?t:r===null?r=Object.getOwnPropertyDescriptor(t,o):r,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")i=Reflect.decorate(e,t,o,r);else for(var l=e.length-1;l>=0;l--)(s=e[l])&&(i=(a<3?s(i):a>3?s(t,o,i):s(t,o))||i);return a>3&&i&&Object.defineProperty(t,o,i),i},et=["SmartSessionList"],tt={PayWithExchange:L.tokens.theme.foregroundPrimary};function Oe(){let e=d.state.data?.connector?.name,t=d.state.data?.wallet?.name,o=d.state.data?.network?.name,r=t??e,a=F.getConnectors(),i=a.length===1&&a[0]?.id==="w3m-email",s=g.getAccountData()?.socialProvider,l=s?s.charAt(0).toUpperCase()+s.slice(1):"Connect Social";return{Connect:`Connect ${i?"Email":""} Wallet`,Create:"Create Wallet",ChooseAccountName:void 0,Account:void 0,AccountSettings:void 0,AllWallets:"All Wallets",ApproveTransaction:"Approve Transaction",BuyInProgress:"Buy",ConnectingExternal:r??"Connect Wallet",ConnectingWalletConnect:r??"WalletConnect",ConnectingWalletConnectBasic:"WalletConnect",ConnectingSiwe:"Sign In",Convert:"Convert",ConvertSelectToken:"Select token",ConvertPreview:"Preview Convert",Downloads:r?`Get ${r}`:"Downloads",EmailLogin:"Email Login",EmailVerifyOtp:"Confirm Email",EmailVerifyDevice:"Register Device",GetWallet:"Get a Wallet",Networks:"Choose Network",OnRampProviders:"Choose Provider",OnRampActivity:"Activity",OnRampTokenSelect:"Select Token",OnRampFiatSelect:"Select Currency",Pay:"How you pay",ProfileWallets:"Wallets",SwitchNetwork:o??"Switch Network",Transactions:"Activity",UnsupportedChain:"Switch Network",UpgradeEmailWallet:"Upgrade Your Wallet",UpdateEmailWallet:"Edit Email",UpdateEmailPrimaryOtp:"Confirm Current Email",UpdateEmailSecondaryOtp:"Confirm New Email",WhatIsABuy:"What is Buy?",RegisterAccountName:"Choose Name",RegisterAccountNameSuccess:"",WalletReceive:"Receive",WalletCompatibleNetworks:"Compatible Networks",Swap:"Swap",SwapSelectToken:"Select Token",SwapPreview:"Preview Swap",WalletSend:"Send",WalletSendPreview:"Review Send",WalletSendSelectToken:"Select Token",WalletSendConfirmed:"Confirmed",WhatIsANetwork:"What is a network?",WhatIsAWallet:"What is a Wallet?",ConnectWallets:"Connect Wallet",ConnectSocials:"All Socials",ConnectingSocial:l,ConnectingMultiChain:"Select Chain",ConnectingFarcaster:"Farcaster",SwitchActiveChain:"Switch Chain",SmartSessionCreated:void 0,SmartSessionList:"Smart Sessions",SIWXSignMessage:"Sign In",PayLoading:"Payment in Progress",DataCapture:"Profile",DataCaptureOtpConfirm:"Confirm Email",FundWallet:"Fund Wallet",PayWithExchange:"Deposit from Exchange",PayWithExchangeSelectAsset:"Select Asset"}}var $=class extends u{constructor(){super(),this.unsubscribe=[],this.heading=Oe()[d.state.view],this.network=g.state.activeCaipNetwork,this.networkImage=q.getNetworkImage(this.network),this.showBack=!1,this.prevHistoryLength=1,this.view=d.state.view,this.viewDirection="",this.unsubscribe.push(ge.subscribeNetworkImages(()=>{this.networkImage=q.getNetworkImage(this.network)}),d.subscribeKey("view",t=>{setTimeout(()=>{this.view=t,this.heading=Oe()[t]},P.ANIMATION_DURATIONS.HeaderText),this.onViewChange(),this.onHistoryChange()}),g.subscribeKey("activeCaipNetwork",t=>{this.network=t,this.networkImage=q.getNetworkImage(this.network)}))}disconnectCallback(){this.unsubscribe.forEach(t=>t())}render(){let t=tt[d.state.view]??L.tokens.theme.backgroundPrimary;return this.style.setProperty("--local-header-background-color",t),n`
      <wui-flex
        .padding=${["0","4","0","4"]}
        justifyContent="space-between"
        alignItems="center"
      >
        ${this.leftHeaderTemplate()} ${this.titleTemplate()} ${this.rightHeaderTemplate()}
      </wui-flex>
    `}onWalletHelp(){R.sendEvent({type:"track",event:"CLICK_WALLET_HELP"}),d.push("WhatIsAWallet")}async onClose(){await J.safeClose()}rightHeaderTemplate(){let t=w?.state?.features?.smartSessions;return d.state.view!=="Account"||!t?this.closeButtonTemplate():n`<wui-flex>
      <wui-icon-button
        icon="clock"
        size="lg"
        iconSize="lg"
        type="neutral"
        variant="primary"
        @click=${()=>d.push("SmartSessionList")}
        data-testid="w3m-header-smart-sessions"
      ></wui-icon-button>
      ${this.closeButtonTemplate()}
    </wui-flex> `}closeButtonTemplate(){return n`
      <wui-icon-button
        icon="close"
        size="lg"
        type="neutral"
        variant="primary"
        iconSize="lg"
        @click=${this.onClose.bind(this)}
        data-testid="w3m-header-close"
      ></wui-icon-button>
    `}titleTemplate(){let t=et.includes(this.view);return n`
      <wui-flex
        view-direction="${this.viewDirection}"
        class="w3m-header-title"
        alignItems="center"
        gap="2"
      >
        <wui-text
          display="inline"
          variant="lg-regular"
          color="primary"
          data-testid="w3m-header-text"
        >
          ${this.heading}
        </wui-text>
        ${t?n`<wui-tag variant="accent" size="md">Beta</wui-tag>`:null}
      </wui-flex>
    `}leftHeaderTemplate(){let{view:t}=d.state,o=t==="Connect",r=w.state.enableEmbedded,a=t==="ApproveTransaction",i=t==="ConnectingSiwe",s=t==="Account",l=w.state.enableNetworkSwitch,W=a||i||o&&r;return s&&l?n`<wui-select
        id="dynamic"
        data-testid="w3m-account-select-network"
        active-network=${b(this.network?.name)}
        @click=${this.onNetworks.bind(this)}
        imageSrc=${b(this.networkImage)}
      ></wui-select>`:this.showBack&&!W?n`<wui-icon-button
        data-testid="header-back"
        id="dynamic"
        icon="chevronLeft"
        size="lg"
        iconSize="lg"
        type="neutral"
        variant="primary"
        @click=${this.onGoBack.bind(this)}
      ></wui-icon-button>`:n`<wui-icon-button
      data-hidden=${!o}
      id="dynamic"
      icon="helpCircle"
      size="lg"
      iconSize="lg"
      type="neutral"
      variant="primary"
      @click=${this.onWalletHelp.bind(this)}
    ></wui-icon-button>`}onNetworks(){this.isAllowedNetworkSwitch()&&(R.sendEvent({type:"track",event:"CLICK_NETWORKS"}),d.push("Networks"))}isAllowedNetworkSwitch(){let t=g.getAllRequestedCaipNetworks(),o=t?t.length>1:!1,r=t?.find(({id:a})=>a===this.network?.id);return o||!r}onViewChange(){let{history:t}=d.state,o=P.VIEW_DIRECTION.Next;t.length<this.prevHistoryLength&&(o=P.VIEW_DIRECTION.Prev),this.prevHistoryLength=t.length,this.viewDirection=o}async onHistoryChange(){let{history:t}=d.state,o=this.shadowRoot?.querySelector("#dynamic");t.length>1&&!this.showBack&&o?(await o.animate([{opacity:1},{opacity:0}],{duration:200,fill:"forwards",easing:"ease"}).finished,this.showBack=!0,o.animate([{opacity:0},{opacity:1}],{duration:200,fill:"forwards",easing:"ease"})):t.length<=1&&this.showBack&&o&&(await o.animate([{opacity:1},{opacity:0}],{duration:200,fill:"forwards",easing:"ease"}).finished,this.showBack=!1,o.animate([{opacity:0},{opacity:1}],{duration:200,fill:"forwards",easing:"ease"}))}onGoBack(){d.goBack()}};$.styles=Re;T([p()],$.prototype,"heading",void 0);T([p()],$.prototype,"network",void 0);T([p()],$.prototype,"networkImage",void 0);T([p()],$.prototype,"showBack",void 0);T([p()],$.prototype,"prevHistoryLength",void 0);T([p()],$.prototype,"view",void 0);T([p()],$.prototype,"viewDirection",void 0);$=T([m("w3m-header")],$);var Pe=h`
  :host {
    display: flex;
    align-items: center;
    gap: ${({spacing:e})=>e[1]};
    padding: ${({spacing:e})=>e[2]} ${({spacing:e})=>e[3]}
      ${({spacing:e})=>e[2]} ${({spacing:e})=>e[2]};
    border-radius: ${({borderRadius:e})=>e[20]};
    background-color: ${({tokens:e})=>e.theme.foregroundPrimary};
    box-shadow:
      0px 0px 8px 0px rgba(0, 0, 0, 0.1),
      inset 0 0 0 1px ${({tokens:e})=>e.theme.borderPrimary};
    max-width: 320px;
  }

  wui-icon-box {
    border-radius: ${({borderRadius:e})=>e.round} !important;
    overflow: hidden;
  }

  wui-loading-spinner {
    padding: ${({spacing:e})=>e[1]};
    background-color: ${({tokens:e})=>e.core.foregroundAccent010};
    border-radius: ${({borderRadius:e})=>e.round} !important;
  }
`;var de=function(e,t,o,r){var a=arguments.length,i=a<3?t:r===null?r=Object.getOwnPropertyDescriptor(t,o):r,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")i=Reflect.decorate(e,t,o,r);else for(var l=e.length-1;l>=0;l--)(s=e[l])&&(i=(a<3?s(i):a>3?s(t,o,i):s(t,o))||i);return a>3&&i&&Object.defineProperty(t,o,i),i},K=class extends u{constructor(){super(...arguments),this.message="",this.variant="success"}render(){return n`
      ${this.templateIcon()}
      <wui-text variant="lg-regular" color="primary" data-testid="wui-snackbar-message"
        >${this.message}</wui-text
      >
    `}templateIcon(){let t={success:"success",error:"error",warning:"warning",info:"default"},o={success:"checkmark",error:"warning",warning:"warningCircle",info:"info"};return this.variant==="loading"?n`<wui-loading-spinner size="md" color="accent-primary"></wui-loading-spinner>`:n`<wui-icon-box
      size="md"
      color=${t[this.variant]}
      icon=${o[this.variant]}
    ></wui-icon-box>`}};K.styles=[C,Pe];de([c()],K.prototype,"message",void 0);de([c()],K.prototype,"variant",void 0);K=de([m("wui-snackbar")],K);var Ae=Q`
  :host {
    display: block;
    position: absolute;
    opacity: 0;
    pointer-events: none;
    top: 11px;
    left: 50%;
    width: max-content;
  }
`;var Ie=function(e,t,o,r){var a=arguments.length,i=a<3?t:r===null?r=Object.getOwnPropertyDescriptor(t,o):r,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")i=Reflect.decorate(e,t,o,r);else for(var l=e.length-1;l>=0;l--)(s=e[l])&&(i=(a<3?s(i):a>3?s(t,o,i):s(t,o))||i);return a>3&&i&&Object.defineProperty(t,o,i),i},ie=class extends u{constructor(){super(),this.unsubscribe=[],this.timeout=void 0,this.open=A.state.open,this.unsubscribe.push(A.subscribeKey("open",t=>{this.open=t,this.onOpen()}))}disconnectedCallback(){clearTimeout(this.timeout),this.unsubscribe.forEach(t=>t())}render(){let{message:t,variant:o}=A.state;return n` <wui-snackbar message=${t} variant=${o}></wui-snackbar> `}onOpen(){clearTimeout(this.timeout),this.open?(this.animate([{opacity:0,transform:"translateX(-50%) scale(0.85)"},{opacity:1,transform:"translateX(-50%) scale(1)"}],{duration:150,fill:"forwards",easing:"ease"}),this.timeout&&clearTimeout(this.timeout),A.state.autoClose&&(this.timeout=setTimeout(()=>A.hide(),2500))):this.animate([{opacity:1,transform:"translateX(-50%) scale(1)"},{opacity:0,transform:"translateX(-50%) scale(0.85)"}],{duration:150,fill:"forwards",easing:"ease"})}};ie.styles=Ae;Ie([p()],ie.prototype,"open",void 0);ie=Ie([m("w3m-snackbar")],ie);var Ne=h`
  :host {
    pointer-events: none;
  }

  :host > wui-flex {
    display: var(--w3m-tooltip-display);
    opacity: var(--w3m-tooltip-opacity);
    padding: 9px ${({spacing:e})=>e[3]} 10px ${({spacing:e})=>e[3]};
    border-radius: ${({borderRadius:e})=>e[3]};
    color: ${({tokens:e})=>e.theme.backgroundPrimary};
    position: absolute;
    top: var(--w3m-tooltip-top);
    left: var(--w3m-tooltip-left);
    transform: translate(calc(-50% + var(--w3m-tooltip-parent-width)), calc(-100% - 8px));
    max-width: calc(var(--apkt-modal-width) - ${({spacing:e})=>e[5]});
    transition: opacity ${({durations:e})=>e.lg}
      ${({easings:e})=>e["ease-out-power-2"]};
    will-change: opacity;
    opacity: 0;
    animation-duration: ${({durations:e})=>e.xl};
    animation-timing-function: ${({easings:e})=>e["ease-out-power-2"]};
    animation-name: fade-in;
    animation-fill-mode: forwards;
  }

  :host([data-variant='shade']) > wui-flex {
    background-color: ${({tokens:e})=>e.theme.foregroundPrimary};
  }

  :host([data-variant='shade']) > wui-flex > wui-text {
    color: ${({tokens:e})=>e.theme.textSecondary};
  }

  :host([data-variant='fill']) > wui-flex {
    background-color: ${({tokens:e})=>e.theme.textPrimary};
    border: none;
  }

  wui-icon {
    position: absolute;
    width: 12px !important;
    height: 4px !important;
    color: ${({tokens:e})=>e.theme.foregroundPrimary};
  }

  wui-icon[data-placement='top'] {
    bottom: 0px;
    left: 50%;
    transform: translate(-50%, 95%);
  }

  wui-icon[data-placement='bottom'] {
    top: 0;
    left: 50%;
    transform: translate(-50%, -95%) rotate(180deg);
  }

  wui-icon[data-placement='right'] {
    top: 50%;
    left: 0;
    transform: translate(-65%, -50%) rotate(90deg);
  }

  wui-icon[data-placement='left'] {
    top: 50%;
    right: 0%;
    transform: translate(65%, -50%) rotate(270deg);
  }

  @keyframes fade-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
`;var M=function(e,t,o,r){var a=arguments.length,i=a<3?t:r===null?r=Object.getOwnPropertyDescriptor(t,o):r,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")i=Reflect.decorate(e,t,o,r);else for(var l=e.length-1;l>=0;l--)(s=e[l])&&(i=(a<3?s(i):a>3?s(t,o,i):s(t,o))||i);return a>3&&i&&Object.defineProperty(t,o,i),i},_=class extends u{constructor(){super(),this.unsubscribe=[],this.open=B.state.open,this.message=B.state.message,this.triggerRect=B.state.triggerRect,this.variant=B.state.variant,this.unsubscribe.push(B.subscribe(t=>{this.open=t.open,this.message=t.message,this.triggerRect=t.triggerRect,this.variant=t.variant}))}disconnectedCallback(){this.unsubscribe.forEach(t=>t())}render(){this.dataset.variant=this.variant;let t=this.triggerRect.top,o=this.triggerRect.left;return this.style.cssText=`
    --w3m-tooltip-top: ${t}px;
    --w3m-tooltip-left: ${o}px;
    --w3m-tooltip-parent-width: ${this.triggerRect.width/2}px;
    --w3m-tooltip-display: ${this.open?"flex":"none"};
    --w3m-tooltip-opacity: ${this.open?1:0};
    `,n`<wui-flex>
      <wui-icon data-placement="top" size="inherit" name="cursor"></wui-icon>
      <wui-text color="primary" variant="sm-regular">${this.message}</wui-text>
    </wui-flex>`}};_.styles=[Ne];M([p()],_.prototype,"open",void 0);M([p()],_.prototype,"message",void 0);M([p()],_.prototype,"triggerRect",void 0);M([p()],_.prototype,"variant",void 0);_=M([m("w3m-tooltip")],_);var z={getTabsByNamespace(e){return!!e&&e===G.CHAIN.EVM?w.state.remoteFeatures?.activity===!1?P.ACCOUNT_TABS.filter(o=>o.label!=="Activity"):P.ACCOUNT_TABS:[]},isValidReownName(e){return/^[a-zA-Z0-9]+$/gu.test(e)},isValidEmail(e){return/^[^\s@]+@[^\s@]+\.[^\s@]+$/gu.test(e)},validateReownName(e){return e.replace(/\^/gu,"").toLowerCase().replace(/[^a-zA-Z0-9]/gu,"")},hasFooter(){let e=d.state.view;if(P.VIEWS_WITH_LEGAL_FOOTER.includes(e)){let{termsConditionsUrl:t,privacyPolicyUrl:o}=w.state,r=w.state.features?.legalCheckbox;return!(!t&&!o||r)}return P.VIEWS_WITH_DEFAULT_FOOTER.includes(e)}};var Te=h`
  :host wui-ux-by-reown {
    padding-top: 0;
  }

  :host wui-ux-by-reown.branding-only {
    padding-top: ${({spacing:e})=>e[3]};
  }

  a {
    text-decoration: none;
    color: ${({tokens:e})=>e.core.textAccentPrimary};
    font-weight: 500;
  }
`;var _e=function(e,t,o,r){var a=arguments.length,i=a<3?t:r===null?r=Object.getOwnPropertyDescriptor(t,o):r,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")i=Reflect.decorate(e,t,o,r);else for(var l=e.length-1;l>=0;l--)(s=e[l])&&(i=(a<3?s(i):a>3?s(t,o,i):s(t,o))||i);return a>3&&i&&Object.defineProperty(t,o,i),i},re=class extends u{constructor(){super(),this.unsubscribe=[],this.remoteFeatures=w.state.remoteFeatures,this.unsubscribe.push(w.subscribeKey("remoteFeatures",t=>this.remoteFeatures=t))}disconnectedCallback(){this.unsubscribe.forEach(t=>t())}render(){let{termsConditionsUrl:t,privacyPolicyUrl:o}=w.state,r=w.state.features?.legalCheckbox;return!t&&!o||r?n`
        <wui-flex flexDirection="column"> ${this.reownBrandingTemplate(!0)} </wui-flex>
      `:n`
      <wui-flex flexDirection="column">
        <wui-flex .padding=${["4","3","3","3"]} justifyContent="center">
          <wui-text color="secondary" variant="md-regular" align="center">
            By connecting your wallet, you agree to our <br />
            ${this.termsTemplate()} ${this.andTemplate()} ${this.privacyTemplate()}
          </wui-text>
        </wui-flex>
        ${this.reownBrandingTemplate()}
      </wui-flex>
    `}andTemplate(){let{termsConditionsUrl:t,privacyPolicyUrl:o}=w.state;return t&&o?"and":""}termsTemplate(){let{termsConditionsUrl:t}=w.state;return t?n`<a href=${t} target="_blank" rel="noopener noreferrer"
      >Terms of Service</a
    >`:null}privacyTemplate(){let{privacyPolicyUrl:t}=w.state;return t?n`<a href=${t} target="_blank" rel="noopener noreferrer"
      >Privacy Policy</a
    >`:null}reownBrandingTemplate(t=!1){return this.remoteFeatures?.reownBranding?t?n`<wui-ux-by-reown class="branding-only"></wui-ux-by-reown>`:n`<wui-ux-by-reown></wui-ux-by-reown>`:null}};re.styles=[Te];_e([p()],re.prototype,"remoteFeatures",void 0);re=_e([m("w3m-legal-footer")],re);var ze=Q``;var ot=function(e,t,o,r){var a=arguments.length,i=a<3?t:r===null?r=Object.getOwnPropertyDescriptor(t,o):r,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")i=Reflect.decorate(e,t,o,r);else for(var l=e.length-1;l>=0;l--)(s=e[l])&&(i=(a<3?s(i):a>3?s(t,o,i):s(t,o))||i);return a>3&&i&&Object.defineProperty(t,o,i),i},pe=class extends u{render(){let{termsConditionsUrl:t,privacyPolicyUrl:o}=w.state;return!t&&!o?null:n`
      <wui-flex
        .padding=${["4","3","3","3"]}
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
        gap="3"
      >
        <wui-text color="secondary" variant="md-regular" align="center">
          We work with the best providers to give you the lowest fees and best support. More options
          coming soon!
        </wui-text>

        ${this.howDoesItWorkTemplate()}
      </wui-flex>
    `}howDoesItWorkTemplate(){return n` <wui-link @click=${this.onWhatIsBuy.bind(this)}>
      <wui-icon size="xs" color="accent-primary" slot="iconLeft" name="helpCircle"></wui-icon>
      How does it work?
    </wui-link>`}onWhatIsBuy(){R.sendEvent({type:"track",event:"SELECT_WHAT_IS_A_BUY",properties:{isSmartAccount:ve(g.state.activeChain)===fe.ACCOUNT_TYPES.SMART_ACCOUNT}}),d.push("WhatIsABuy")}};pe.styles=[ze];pe=ot([m("w3m-onramp-providers-footer")],pe);var De=h`
  :host {
    display: block;
  }

  div.container {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    overflow: hidden;
    height: auto;
    display: block;
  }

  div.container[status='hide'] {
    animation: fade-out;
    animation-duration: var(--apkt-duration-dynamic);
    animation-timing-function: ${({easings:e})=>e["ease-out-power-2"]};
    animation-fill-mode: both;
    animation-delay: 0s;
  }

  div.container[status='show'] {
    animation: fade-in;
    animation-duration: var(--apkt-duration-dynamic);
    animation-timing-function: ${({easings:e})=>e["ease-out-power-2"]};
    animation-fill-mode: both;
    animation-delay: var(--apkt-duration-dynamic);
  }

  @keyframes fade-in {
    from {
      opacity: 0;
      filter: blur(6px);
    }
    to {
      opacity: 1;
      filter: blur(0px);
    }
  }

  @keyframes fade-out {
    from {
      opacity: 1;
      filter: blur(0px);
    }
    to {
      opacity: 0;
      filter: blur(6px);
    }
  }
`;var me=function(e,t,o,r){var a=arguments.length,i=a<3?t:r===null?r=Object.getOwnPropertyDescriptor(t,o):r,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")i=Reflect.decorate(e,t,o,r);else for(var l=e.length-1;l>=0;l--)(s=e[l])&&(i=(a<3?s(i):a>3?s(t,o,i):s(t,o))||i);return a>3&&i&&Object.defineProperty(t,o,i),i},Y=class extends u{constructor(){super(...arguments),this.resizeObserver=void 0,this.unsubscribe=[],this.status="hide",this.view=d.state.view}firstUpdated(){this.status=z.hasFooter()?"show":"hide",this.unsubscribe.push(d.subscribeKey("view",t=>{this.view=t,this.status=z.hasFooter()?"show":"hide",this.status==="hide"&&document.documentElement.style.setProperty("--apkt-footer-height","0px")})),this.resizeObserver=new ResizeObserver(t=>{for(let o of t)if(o.target===this.getWrapper()){let r=`${o.contentRect.height}px`;document.documentElement.style.setProperty("--apkt-footer-height",r)}}),this.resizeObserver.observe(this.getWrapper())}render(){return n`
      <div class="container" status=${this.status}>${this.templatePageContainer()}</div>
    `}templatePageContainer(){return z.hasFooter()?n` ${this.templateFooter()}`:null}templateFooter(){switch(this.view){case"Networks":return this.templateNetworksFooter();case"Connect":case"ConnectWallets":case"OnRampFiatSelect":case"OnRampTokenSelect":return n`<w3m-legal-footer></w3m-legal-footer>`;case"OnRampProviders":return n`<w3m-onramp-providers-footer></w3m-onramp-providers-footer>`;default:return null}}templateNetworksFooter(){return n` <wui-flex
      class="footer-in"
      padding="3"
      flexDirection="column"
      gap="3"
      alignItems="center"
    >
      <wui-text variant="md-regular" color="secondary" align="center">
        Your connected wallet may not support some of the networks available for this dApp
      </wui-text>
      <wui-link @click=${this.onNetworkHelp.bind(this)}>
        <wui-icon size="sm" color="accent-primary" slot="iconLeft" name="helpCircle"></wui-icon>
        What is a network
      </wui-link>
    </wui-flex>`}onNetworkHelp(){R.sendEvent({type:"track",event:"CLICK_NETWORK_HELP"}),d.push("WhatIsANetwork")}getWrapper(){return this.shadowRoot?.querySelector("div.container")}};Y.styles=[De];me([p()],Y.prototype,"status",void 0);me([p()],Y.prototype,"view",void 0);Y=me([m("w3m-footer")],Y);var Be=h`
  :host {
    display: block;
    width: inherit;
  }
`;var ue=function(e,t,o,r){var a=arguments.length,i=a<3?t:r===null?r=Object.getOwnPropertyDescriptor(t,o):r,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")i=Reflect.decorate(e,t,o,r);else for(var l=e.length-1;l>=0;l--)(s=e[l])&&(i=(a<3?s(i):a>3?s(t,o,i):s(t,o))||i);return a>3&&i&&Object.defineProperty(t,o,i),i},X=class extends u{constructor(){super(),this.unsubscribe=[],this.viewState=d.state.view,this.history=d.state.history.join(","),this.unsubscribe.push(d.subscribeKey("view",()=>{this.history=d.state.history.join(","),document.documentElement.style.setProperty("--apkt-duration-dynamic","var(--apkt-durations-lg)")}))}disconnectedCallback(){this.unsubscribe.forEach(t=>t()),document.documentElement.style.setProperty("--apkt-duration-dynamic","0s")}render(){return n`${this.templatePageContainer()}`}templatePageContainer(){return n`<w3m-router-container
      history=${this.history}
      .setView=${()=>{this.viewState=d.state.view}}
    >
      ${this.viewTemplate(this.viewState)}
    </w3m-router-container>`}viewTemplate(t){switch(t){case"AccountSettings":return n`<w3m-account-settings-view></w3m-account-settings-view>`;case"Account":return n`<w3m-account-view></w3m-account-view>`;case"AllWallets":return n`<w3m-all-wallets-view></w3m-all-wallets-view>`;case"ApproveTransaction":return n`<w3m-approve-transaction-view></w3m-approve-transaction-view>`;case"BuyInProgress":return n`<w3m-buy-in-progress-view></w3m-buy-in-progress-view>`;case"ChooseAccountName":return n`<w3m-choose-account-name-view></w3m-choose-account-name-view>`;case"Connect":return n`<w3m-connect-view></w3m-connect-view>`;case"Create":return n`<w3m-connect-view walletGuide="explore"></w3m-connect-view>`;case"ConnectingWalletConnect":return n`<w3m-connecting-wc-view></w3m-connecting-wc-view>`;case"ConnectingWalletConnectBasic":return n`<w3m-connecting-wc-basic-view></w3m-connecting-wc-basic-view>`;case"ConnectingExternal":return n`<w3m-connecting-external-view></w3m-connecting-external-view>`;case"ConnectingSiwe":return n`<w3m-connecting-siwe-view></w3m-connecting-siwe-view>`;case"ConnectWallets":return n`<w3m-connect-wallets-view></w3m-connect-wallets-view>`;case"ConnectSocials":return n`<w3m-connect-socials-view></w3m-connect-socials-view>`;case"ConnectingSocial":return n`<w3m-connecting-social-view></w3m-connecting-social-view>`;case"DataCapture":return n`<w3m-data-capture-view></w3m-data-capture-view>`;case"DataCaptureOtpConfirm":return n`<w3m-data-capture-otp-confirm-view></w3m-data-capture-otp-confirm-view>`;case"Downloads":return n`<w3m-downloads-view></w3m-downloads-view>`;case"EmailLogin":return n`<w3m-email-login-view></w3m-email-login-view>`;case"EmailVerifyOtp":return n`<w3m-email-verify-otp-view></w3m-email-verify-otp-view>`;case"EmailVerifyDevice":return n`<w3m-email-verify-device-view></w3m-email-verify-device-view>`;case"GetWallet":return n`<w3m-get-wallet-view></w3m-get-wallet-view>`;case"Networks":return n`<w3m-networks-view></w3m-networks-view>`;case"SwitchNetwork":return n`<w3m-network-switch-view></w3m-network-switch-view>`;case"ProfileWallets":return n`<w3m-profile-wallets-view></w3m-profile-wallets-view>`;case"Transactions":return n`<w3m-transactions-view></w3m-transactions-view>`;case"OnRampProviders":return n`<w3m-onramp-providers-view></w3m-onramp-providers-view>`;case"OnRampTokenSelect":return n`<w3m-onramp-token-select-view></w3m-onramp-token-select-view>`;case"OnRampFiatSelect":return n`<w3m-onramp-fiat-select-view></w3m-onramp-fiat-select-view>`;case"UpgradeEmailWallet":return n`<w3m-upgrade-wallet-view></w3m-upgrade-wallet-view>`;case"UpdateEmailWallet":return n`<w3m-update-email-wallet-view></w3m-update-email-wallet-view>`;case"UpdateEmailPrimaryOtp":return n`<w3m-update-email-primary-otp-view></w3m-update-email-primary-otp-view>`;case"UpdateEmailSecondaryOtp":return n`<w3m-update-email-secondary-otp-view></w3m-update-email-secondary-otp-view>`;case"UnsupportedChain":return n`<w3m-unsupported-chain-view></w3m-unsupported-chain-view>`;case"Swap":return n`<w3m-swap-view></w3m-swap-view>`;case"SwapSelectToken":return n`<w3m-swap-select-token-view></w3m-swap-select-token-view>`;case"SwapPreview":return n`<w3m-swap-preview-view></w3m-swap-preview-view>`;case"WalletSend":return n`<w3m-wallet-send-view></w3m-wallet-send-view>`;case"WalletSendSelectToken":return n`<w3m-wallet-send-select-token-view></w3m-wallet-send-select-token-view>`;case"WalletSendPreview":return n`<w3m-wallet-send-preview-view></w3m-wallet-send-preview-view>`;case"WalletSendConfirmed":return n`<w3m-send-confirmed-view></w3m-send-confirmed-view>`;case"WhatIsABuy":return n`<w3m-what-is-a-buy-view></w3m-what-is-a-buy-view>`;case"WalletReceive":return n`<w3m-wallet-receive-view></w3m-wallet-receive-view>`;case"WalletCompatibleNetworks":return n`<w3m-wallet-compatible-networks-view></w3m-wallet-compatible-networks-view>`;case"WhatIsAWallet":return n`<w3m-what-is-a-wallet-view></w3m-what-is-a-wallet-view>`;case"ConnectingMultiChain":return n`<w3m-connecting-multi-chain-view></w3m-connecting-multi-chain-view>`;case"WhatIsANetwork":return n`<w3m-what-is-a-network-view></w3m-what-is-a-network-view>`;case"ConnectingFarcaster":return n`<w3m-connecting-farcaster-view></w3m-connecting-farcaster-view>`;case"SwitchActiveChain":return n`<w3m-switch-active-chain-view></w3m-switch-active-chain-view>`;case"RegisterAccountName":return n`<w3m-register-account-name-view></w3m-register-account-name-view>`;case"RegisterAccountNameSuccess":return n`<w3m-register-account-name-success-view></w3m-register-account-name-success-view>`;case"SmartSessionCreated":return n`<w3m-smart-session-created-view></w3m-smart-session-created-view>`;case"SmartSessionList":return n`<w3m-smart-session-list-view></w3m-smart-session-list-view>`;case"SIWXSignMessage":return n`<w3m-siwx-sign-message-view></w3m-siwx-sign-message-view>`;case"Pay":return n`<w3m-pay-view></w3m-pay-view>`;case"PayLoading":return n`<w3m-pay-loading-view></w3m-pay-loading-view>`;case"FundWallet":return n`<w3m-fund-wallet-view></w3m-fund-wallet-view>`;case"PayWithExchange":return n`<w3m-deposit-from-exchange-view></w3m-deposit-from-exchange-view>`;case"PayWithExchangeSelectAsset":return n`<w3m-deposit-from-exchange-select-asset-view></w3m-deposit-from-exchange-select-asset-view>`;default:return n`<w3m-connect-view></w3m-connect-view>`}}};X.styles=[Be];ue([p()],X.prototype,"viewState",void 0);ue([p()],X.prototype,"history",void 0);X=ue([m("w3m-router")],X);var Le=h`
  :host {
    z-index: ${({tokens:e})=>e.core.zIndex};
    display: block;
    backface-visibility: hidden;
    will-change: opacity;
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    pointer-events: none;
    opacity: 0;
    background-color: ${({tokens:e})=>e.theme.overlay};
    backdrop-filter: blur(0px);
    transition:
      opacity ${({durations:e})=>e.lg} ${({easings:e})=>e["ease-out-power-2"]},
      backdrop-filter ${({durations:e})=>e.lg}
        ${({easings:e})=>e["ease-out-power-2"]};
    will-change: opacity;
  }

  :host(.open) {
    opacity: 1;
    backdrop-filter: blur(8px);
  }

  :host(.appkit-modal) {
    position: relative;
    pointer-events: unset;
    background: none;
    width: 100%;
    opacity: 1;
  }

  wui-card {
    max-width: var(--apkt-modal-width);
    width: 100%;
    position: relative;
    outline: none;
    transform: translateY(4px);
    box-shadow: 0 2px 8px 0 rgba(0, 0, 0, 0.05);
    transition:
      transform ${({durations:e})=>e.lg}
        ${({easings:e})=>e["ease-out-power-2"]},
      border-radius ${({durations:e})=>e.lg}
        ${({easings:e})=>e["ease-out-power-1"]},
      background-color ${({durations:e})=>e.lg}
        ${({easings:e})=>e["ease-out-power-1"]},
      box-shadow ${({durations:e})=>e.lg}
        ${({easings:e})=>e["ease-out-power-1"]};
    will-change: border-radius, background-color, transform, box-shadow;
    background-color: ${({tokens:e})=>e.theme.backgroundPrimary};
    padding: var(--local-modal-padding);
    box-sizing: border-box;
  }

  :host(.open) wui-card {
    transform: translateY(0px);
  }

  wui-card::before {
    z-index: 1;
    pointer-events: none;
    content: '';
    position: absolute;
    inset: 0;
    border-radius: clamp(0px, var(--apkt-borderRadius-8), 44px);
    transition: box-shadow ${({durations:e})=>e.lg}
      ${({easings:e})=>e["ease-out-power-2"]};
    transition-delay: ${({durations:e})=>e.md};
    will-change: box-shadow;
  }

  :host([data-mobile-fullscreen='true']) wui-card::before {
    border-radius: 0px;
  }

  :host([data-border='true']) wui-card::before {
    box-shadow: inset 0px 0px 0px 4px ${({tokens:e})=>e.theme.foregroundSecondary};
  }

  :host([data-border='false']) wui-card::before {
    box-shadow: inset 0px 0px 0px 1px ${({tokens:e})=>e.theme.borderPrimaryDark};
  }

  :host([data-border='true']) wui-card {
    animation:
      fade-in ${({durations:e})=>e.lg} ${({easings:e})=>e["ease-out-power-2"]},
      card-background-border var(--apkt-duration-dynamic)
        ${({easings:e})=>e["ease-out-power-2"]};
    animation-fill-mode: backwards, both;
    animation-delay: var(--apkt-duration-dynamic);
  }

  :host([data-border='false']) wui-card {
    animation:
      fade-in ${({durations:e})=>e.lg} ${({easings:e})=>e["ease-out-power-2"]},
      card-background-default var(--apkt-duration-dynamic)
        ${({easings:e})=>e["ease-out-power-2"]};
    animation-fill-mode: backwards, both;
    animation-delay: 0s;
  }

  :host(.appkit-modal) wui-card {
    max-width: var(--apkt-modal-width);
  }

  wui-card[shake='true'] {
    animation:
      fade-in ${({durations:e})=>e.lg} ${({easings:e})=>e["ease-out-power-2"]},
      w3m-shake ${({durations:e})=>e.xl}
        ${({easings:e})=>e["ease-out-power-2"]};
  }

  wui-flex {
    overflow-x: hidden;
    overflow-y: auto;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
  }

  @media (max-height: 700px) and (min-width: 431px) {
    wui-flex {
      align-items: flex-start;
    }

    wui-card {
      margin: var(--apkt-spacing-6) 0px;
    }
  }

  @media (max-width: 430px) {
    :host([data-mobile-fullscreen='true']) {
      height: 100dvh;
    }
    :host([data-mobile-fullscreen='true']) wui-flex {
      align-items: stretch;
    }
    :host([data-mobile-fullscreen='true']) wui-card {
      max-width: 100%;
      height: 100%;
      border-radius: 0;
      border: none;
    }
    :host(:not([data-mobile-fullscreen='true'])) wui-flex {
      align-items: flex-end;
    }

    :host(:not([data-mobile-fullscreen='true'])) wui-card {
      max-width: 100%;
      border-bottom: none;
    }

    :host(:not([data-mobile-fullscreen='true'])) wui-card[data-embedded='true'] {
      border-bottom-left-radius: clamp(0px, var(--apkt-borderRadius-8), 44px);
      border-bottom-right-radius: clamp(0px, var(--apkt-borderRadius-8), 44px);
    }

    :host(:not([data-mobile-fullscreen='true'])) wui-card:not([data-embedded='true']) {
      border-bottom-left-radius: 0px;
      border-bottom-right-radius: 0px;
    }

    wui-card[shake='true'] {
      animation: w3m-shake 0.5s ${({easings:e})=>e["ease-out-power-2"]};
    }
  }

  @keyframes fade-in {
    0% {
      transform: scale(0.99) translateY(4px);
    }
    100% {
      transform: scale(1) translateY(0);
    }
  }

  @keyframes w3m-shake {
    0% {
      transform: scale(1) rotate(0deg);
    }
    20% {
      transform: scale(1) rotate(-1deg);
    }
    40% {
      transform: scale(1) rotate(1.5deg);
    }
    60% {
      transform: scale(1) rotate(-1.5deg);
    }
    80% {
      transform: scale(1) rotate(1deg);
    }
    100% {
      transform: scale(1) rotate(0deg);
    }
  }

  @keyframes card-background-border {
    from {
      background-color: ${({tokens:e})=>e.theme.backgroundPrimary};
    }
    to {
      background-color: ${({tokens:e})=>e.theme.foregroundSecondary};
    }
  }

  @keyframes card-background-default {
    from {
      background-color: ${({tokens:e})=>e.theme.foregroundSecondary};
    }
    to {
      background-color: ${({tokens:e})=>e.theme.backgroundPrimary};
    }
  }
`;var S=function(e,t,o,r){var a=arguments.length,i=a<3?t:r===null?r=Object.getOwnPropertyDescriptor(t,o):r,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")i=Reflect.decorate(e,t,o,r);else for(var l=e.length-1;l>=0;l--)(s=e[l])&&(i=(a<3?s(i):a>3?s(t,o,i):s(t,o))||i);return a>3&&i&&Object.defineProperty(t,o,i),i},He="scroll-lock",it={PayWithExchange:"0",PayWithExchangeSelectAsset:"0"},y=class extends u{constructor(){super(),this.unsubscribe=[],this.abortController=void 0,this.hasPrefetched=!1,this.enableEmbedded=w.state.enableEmbedded,this.open=O.state.open,this.caipAddress=g.state.activeCaipAddress,this.caipNetwork=g.state.activeCaipNetwork,this.shake=O.state.shake,this.filterByNamespace=F.state.filterByNamespace,this.padding=L.spacing[1],this.mobileFullScreen=w.state.enableMobileFullScreen,this.initializeTheming(),j.prefetchAnalyticsConfig(),this.unsubscribe.push(O.subscribeKey("open",t=>t?this.onOpen():this.onClose()),O.subscribeKey("shake",t=>this.shake=t),g.subscribeKey("activeCaipNetwork",t=>this.onNewNetwork(t)),g.subscribeKey("activeCaipAddress",t=>this.onNewAddress(t)),w.subscribeKey("enableEmbedded",t=>this.enableEmbedded=t),F.subscribeKey("filterByNamespace",t=>{this.filterByNamespace!==t&&!g.getAccountData(t)?.caipAddress&&(j.fetchRecommendedWallets(),this.filterByNamespace=t)}),d.subscribeKey("view",()=>{this.dataset.border=z.hasFooter()?"true":"false",this.padding=it[d.state.view]??L.spacing[1]}))}firstUpdated(){if(this.dataset.border=z.hasFooter()?"true":"false",this.mobileFullScreen&&this.setAttribute("data-mobile-fullscreen","true"),this.caipAddress){if(this.enableEmbedded){O.close(),this.prefetch();return}this.onNewAddress(this.caipAddress)}this.open&&this.onOpen(),this.enableEmbedded&&this.prefetch()}disconnectedCallback(){this.unsubscribe.forEach(t=>t()),this.onRemoveKeyboardListener()}render(){return this.style.setProperty("--local-modal-padding",this.padding),this.enableEmbedded?n`${this.contentTemplate()}
        <w3m-tooltip></w3m-tooltip> `:this.open?n`
          <wui-flex @click=${this.onOverlayClick.bind(this)} data-testid="w3m-modal-overlay">
            ${this.contentTemplate()}
          </wui-flex>
          <w3m-tooltip></w3m-tooltip>
        `:null}contentTemplate(){return n` <wui-card
      shake="${this.shake}"
      data-embedded="${b(this.enableEmbedded)}"
      role="alertdialog"
      aria-modal="true"
      tabindex="0"
      data-testid="w3m-modal-card"
    >
      <w3m-header></w3m-header>
      <w3m-router></w3m-router>
      <w3m-footer></w3m-footer>
      <w3m-snackbar></w3m-snackbar>
      <w3m-alertbar></w3m-alertbar>
    </wui-card>`}async onOverlayClick(t){if(t.target===t.currentTarget){if(this.mobileFullScreen)return;await this.handleClose()}}async handleClose(){await J.safeClose()}initializeTheming(){let{themeVariables:t,themeMode:o}=be.state,r=te.getColorTheme(o);xe(t,r)}onClose(){this.open=!1,this.classList.remove("open"),this.onScrollUnlock(),A.hide(),this.onRemoveKeyboardListener()}onOpen(){this.open=!0,this.classList.add("open"),this.onScrollLock(),this.onAddKeyboardListener()}onScrollLock(){let t=document.createElement("style");t.dataset.w3m=He,t.textContent=`
      body {
        touch-action: none;
        overflow: hidden;
        overscroll-behavior: contain;
      }
      w3m-modal {
        pointer-events: auto;
      }
    `,document.head.appendChild(t)}onScrollUnlock(){let t=document.head.querySelector(`style[data-w3m="${He}"]`);t&&t.remove()}onAddKeyboardListener(){this.abortController=new AbortController;let t=this.shadowRoot?.querySelector("wui-card");t?.focus(),window.addEventListener("keydown",o=>{if(o.key==="Escape")this.handleClose();else if(o.key==="Tab"){let{tagName:r}=o.target;r&&!r.includes("W3M-")&&!r.includes("WUI-")&&t?.focus()}},this.abortController)}onRemoveKeyboardListener(){this.abortController?.abort(),this.abortController=void 0}async onNewAddress(t){let o=g.state.isSwitchingNamespace,r=d.state.view==="ProfileWallets";t?await this.onConnected({caipAddress:t,isSwitchingNamespace:o,isInProfileView:r}):!o&&!this.enableEmbedded&&!r&&O.close(),await Z.initializeIfEnabled(t),this.caipAddress=t,g.setIsSwitchingNamespace(!1)}async onConnected(t){if(t.isInProfileView)return;let{chainNamespace:o,chainId:r,address:a}=he.parseCaipAddress(t.caipAddress),i=`${o}:${r}`,s=!we.getPlainAddress(this.caipAddress),l=await Z.getSessions({address:a,caipNetworkId:i}),W=Z.getSIWX()?l.some(se=>se.data.accountAddress===a):!0,ne=t.isSwitchingNamespace&&W&&!this.enableEmbedded,ae=this.enableEmbedded&&s;ne?d.goBack():ae&&O.close()}onNewNetwork(t){let o=this.caipNetwork,r=o?.caipNetworkId?.toString(),a=o?.chainNamespace,i=t?.caipNetworkId?.toString(),s=t?.chainNamespace,l=r!==i,ne=l&&!(a!==s),ae=o?.name===G.UNSUPPORTED_NETWORK_NAME,se=d.state.view==="ConnectingExternal",Ke=d.state.view==="ProfileWallets",Me=!g.getAccountData(t?.chainNamespace)?.caipAddress,Ye=d.state.view==="UnsupportedChain",Xe=O.state.open,U=!1;this.enableEmbedded&&d.state.view==="SwitchNetwork"&&(U=!0),l&&ye.resetState(),Xe&&!se&&!Ke&&(Me?l&&(U=!0):(Ye||ne&&!ae)&&(U=!0)),U&&d.state.view!=="SIWXSignMessage"&&d.goBack(),this.caipNetwork=t}prefetch(){this.hasPrefetched||(j.prefetch(),j.fetchWalletsByPage({page:1}),this.hasPrefetched=!0)}};y.styles=Le;S([c({type:Boolean})],y.prototype,"enableEmbedded",void 0);S([p()],y.prototype,"open",void 0);S([p()],y.prototype,"caipAddress",void 0);S([p()],y.prototype,"caipNetwork",void 0);S([p()],y.prototype,"shake",void 0);S([p()],y.prototype,"filterByNamespace",void 0);S([p()],y.prototype,"padding",void 0);S([p()],y.prototype,"mobileFullScreen",void 0);var Ue=class extends y{};Ue=S([m("w3m-modal")],Ue);var je=class extends y{};je=S([m("appkit-modal")],je);var Fe=h`
  :host {
    width: 100%;
  }
`;var v=function(e,t,o,r){var a=arguments.length,i=a<3?t:r===null?r=Object.getOwnPropertyDescriptor(t,o):r,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")i=Reflect.decorate(e,t,o,r);else for(var l=e.length-1;l>=0;l--)(s=e[l])&&(i=(a<3?s(i):a>3?s(t,o,i):s(t,o))||i);return a>3&&i&&Object.defineProperty(t,o,i),i},f=class extends u{constructor(){super(...arguments),this.hasImpressionSent=!1,this.walletImages=[],this.imageSrc="",this.name="",this.size="md",this.tabIdx=void 0,this.disabled=!1,this.showAllWallets=!1,this.loading=!1,this.loadingSpinnerColor="accent-100",this.rdnsId="",this.displayIndex=void 0,this.walletRank=void 0}connectedCallback(){super.connectedCallback()}disconnectedCallback(){super.disconnectedCallback(),this.cleanupIntersectionObserver()}updated(t){super.updated(t),(t.has("name")||t.has("imageSrc")||t.has("walletRank"))&&(this.hasImpressionSent=!1),t.has("walletRank")&&this.walletRank&&!this.intersectionObserver&&this.setupIntersectionObserver()}setupIntersectionObserver(){this.intersectionObserver=new IntersectionObserver(t=>{t.forEach(o=>{o.isIntersecting&&!this.loading&&!this.hasImpressionSent&&this.sendImpressionEvent()})},{threshold:.1}),this.intersectionObserver.observe(this)}cleanupIntersectionObserver(){this.intersectionObserver&&(this.intersectionObserver.disconnect(),this.intersectionObserver=void 0)}sendImpressionEvent(){!this.name||this.hasImpressionSent||!this.walletRank||(this.hasImpressionSent=!0,(this.rdnsId||this.name)&&R.sendWalletImpressionEvent({name:this.name,walletRank:this.walletRank,rdnsId:this.rdnsId,view:d.state.view,displayIndex:this.displayIndex}))}render(){return n`
      <wui-list-wallet
        .walletImages=${this.walletImages}
        imageSrc=${b(this.imageSrc)}
        name=${this.name}
        size=${b(this.size)}
        tagLabel=${b(this.tagLabel)}
        .tagVariant=${this.tagVariant}
        .walletIcon=${this.walletIcon}
        .tabIdx=${this.tabIdx}
        .disabled=${this.disabled}
        .showAllWallets=${this.showAllWallets}
        .loading=${this.loading}
        loadingSpinnerColor=${this.loadingSpinnerColor}
      ></wui-list-wallet>
    `}};f.styles=Fe;v([c({type:Array})],f.prototype,"walletImages",void 0);v([c()],f.prototype,"imageSrc",void 0);v([c()],f.prototype,"name",void 0);v([c()],f.prototype,"size",void 0);v([c()],f.prototype,"tagLabel",void 0);v([c()],f.prototype,"tagVariant",void 0);v([c()],f.prototype,"walletIcon",void 0);v([c()],f.prototype,"tabIdx",void 0);v([c({type:Boolean})],f.prototype,"disabled",void 0);v([c({type:Boolean})],f.prototype,"showAllWallets",void 0);v([c({type:Boolean})],f.prototype,"loading",void 0);v([c({type:String})],f.prototype,"loadingSpinnerColor",void 0);v([c()],f.prototype,"rdnsId",void 0);v([c()],f.prototype,"displayIndex",void 0);v([c()],f.prototype,"walletRank",void 0);f=v([m("w3m-list-wallet")],f);var Ve=h`
  :host {
    --local-duration-height: 0s;
    --local-duration: ${({durations:e})=>e.lg};
    --local-transition: ${({easings:e})=>e["ease-out-power-2"]};
  }

  .container {
    display: block;
    overflow: hidden;
    overflow: hidden;
    position: relative;
    height: var(--local-container-height);
    transition: height var(--local-duration-height) var(--local-transition);
    will-change: height, padding-bottom;
  }

  .container[data-mobile-fullscreen='true'] {
    overflow: scroll;
  }

  .page {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    width: 100%;
    height: auto;
    width: inherit;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    background-color: ${({tokens:e})=>e.theme.backgroundPrimary};
    border-bottom-left-radius: var(--local-border-bottom-radius);
    border-bottom-right-radius: var(--local-border-bottom-radius);
    transition: border-bottom-left-radius var(--local-duration) var(--local-transition);
  }

  .page[data-mobile-fullscreen='true'] {
    height: 100%;
  }

  .page-content {
    display: flex;
    flex-direction: column;
    min-height: 100%;
  }

  .footer {
    height: var(--apkt-footer-height);
  }

  div.page[view-direction^='prev-'] .page-content {
    animation:
      slide-left-out var(--local-duration) forwards var(--local-transition),
      slide-left-in var(--local-duration) forwards var(--local-transition);
    animation-delay: 0ms, var(--local-duration, ${({durations:e})=>e.lg});
  }

  div.page[view-direction^='next-'] .page-content {
    animation:
      slide-right-out var(--local-duration) forwards var(--local-transition),
      slide-right-in var(--local-duration) forwards var(--local-transition);
    animation-delay: 0ms, var(--local-duration, ${({durations:e})=>e.lg});
  }

  @keyframes slide-left-out {
    from {
      transform: translateX(0px) scale(1);
      opacity: 1;
      filter: blur(0px);
    }
    to {
      transform: translateX(8px) scale(0.99);
      opacity: 0;
      filter: blur(4px);
    }
  }

  @keyframes slide-left-in {
    from {
      transform: translateX(-8px) scale(0.99);
      opacity: 0;
      filter: blur(4px);
    }
    to {
      transform: translateX(0) translateY(0) scale(1);
      opacity: 1;
      filter: blur(0px);
    }
  }

  @keyframes slide-right-out {
    from {
      transform: translateX(0px) scale(1);
      opacity: 1;
      filter: blur(0px);
    }
    to {
      transform: translateX(-8px) scale(0.99);
      opacity: 0;
      filter: blur(4px);
    }
  }

  @keyframes slide-right-in {
    from {
      transform: translateX(8px) scale(0.99);
      opacity: 0;
      filter: blur(4px);
    }
    to {
      transform: translateX(0) translateY(0) scale(1);
      opacity: 1;
      filter: blur(0px);
    }
  }
`;var E=function(e,t,o,r){var a=arguments.length,i=a<3?t:r===null?r=Object.getOwnPropertyDescriptor(t,o):r,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")i=Reflect.decorate(e,t,o,r);else for(var l=e.length-1;l>=0;l--)(s=e[l])&&(i=(a<3?s(i):a>3?s(t,o,i):s(t,o))||i);return a>3&&i&&Object.defineProperty(t,o,i),i},rt=60,x=class extends u{constructor(){super(...arguments),this.resizeObserver=void 0,this.transitionDuration="0.15s",this.transitionFunction="",this.history="",this.view="",this.setView=void 0,this.viewDirection="",this.historyState="",this.previousHeight="0px",this.mobileFullScreen=w.state.enableMobileFullScreen,this.onViewportResize=()=>{this.updateContainerHeight()}}updated(t){if(t.has("history")){let o=this.history;this.historyState!==""&&this.historyState!==o&&this.onViewChange(o)}t.has("transitionDuration")&&this.style.setProperty("--local-duration",this.transitionDuration),t.has("transitionFunction")&&this.style.setProperty("--local-transition",this.transitionFunction)}firstUpdated(){this.transitionFunction&&this.style.setProperty("--local-transition",this.transitionFunction),this.style.setProperty("--local-duration",this.transitionDuration),this.historyState=this.history,this.resizeObserver=new ResizeObserver(t=>{for(let o of t)if(o.target===this.getWrapper()){let r=o.contentRect.height,a=parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--apkt-footer-height")||"0");if(this.mobileFullScreen){let i=window.visualViewport?.height||window.innerHeight,s=this.getHeaderHeight();r=i-s-a,this.style.setProperty("--local-border-bottom-radius","0px")}else r=r+a,this.style.setProperty("--local-border-bottom-radius",a?"var(--apkt-borderRadius-5)":"0px");this.style.setProperty("--local-container-height",`${r}px`),this.previousHeight!=="0px"&&this.style.setProperty("--local-duration-height",this.transitionDuration),this.previousHeight=`${r}px`}}),this.resizeObserver.observe(this.getWrapper()),this.updateContainerHeight(),window.addEventListener("resize",this.onViewportResize),window.visualViewport?.addEventListener("resize",this.onViewportResize)}disconnectedCallback(){let t=this.getWrapper();t&&this.resizeObserver&&this.resizeObserver.unobserve(t),window.removeEventListener("resize",this.onViewportResize),window.visualViewport?.removeEventListener("resize",this.onViewportResize)}render(){return n`
      <div class="container" data-mobile-fullscreen="${b(this.mobileFullScreen)}">
        <div
          class="page"
          data-mobile-fullscreen="${b(this.mobileFullScreen)}"
          view-direction="${this.viewDirection}"
        >
          <div class="page-content">
            <slot></slot>
          </div>
        </div>
      </div>
    `}onViewChange(t){let o=t.split(",").filter(Boolean),r=this.historyState.split(",").filter(Boolean),a=r.length,i=o.length,s=o[o.length-1]||"",l=te.cssDurationToNumber(this.transitionDuration),W="";i>a?W="next":i<a?W="prev":i===a&&o[i-1]!==r[a-1]&&(W="next"),this.viewDirection=`${W}-${s}`,setTimeout(()=>{this.historyState=t,this.setView?.(s)},l),setTimeout(()=>{this.viewDirection=""},l*2)}getWrapper(){return this.shadowRoot?.querySelector("div.page")}updateContainerHeight(){let t=this.getWrapper();if(!t)return;let o=parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--apkt-footer-height")||"0"),r=0;if(this.mobileFullScreen){let a=window.visualViewport?.height||window.innerHeight,i=this.getHeaderHeight();r=a-i-o,this.style.setProperty("--local-border-bottom-radius","0px")}else r=t.getBoundingClientRect().height+o,this.style.setProperty("--local-border-bottom-radius",o?"var(--apkt-borderRadius-5)":"0px");this.style.setProperty("--local-container-height",`${r}px`),this.previousHeight!=="0px"&&this.style.setProperty("--local-duration-height",this.transitionDuration),this.previousHeight=`${r}px`}getHeaderHeight(){return rt}};x.styles=[Ve];E([c({type:String})],x.prototype,"transitionDuration",void 0);E([c({type:String})],x.prototype,"transitionFunction",void 0);E([c({type:String})],x.prototype,"history",void 0);E([c({type:String})],x.prototype,"view",void 0);E([c({attribute:!1})],x.prototype,"setView",void 0);E([p()],x.prototype,"viewDirection",void 0);E([p()],x.prototype,"historyState",void 0);E([p()],x.prototype,"previousHeight",void 0);E([p()],x.prototype,"mobileFullScreen",void 0);x=E([m("w3m-router-container")],x);export{je as AppKitModal,f as W3mListWallet,Ue as W3mModal,y as W3mModalBase,x as W3mRouterContainer};
