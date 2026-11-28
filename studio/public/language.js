(function(){
  "use strict";
  var STORAGE_KEY="icha-language";
  function getBrowserLanguage(){
    var candidates=(navigator.languages&&navigator.languages.length?navigator.languages:[navigator.language||"en"]);
    for(var i=0;i<candidates.length;i++){
      var raw=String(candidates[i]||"en").toLowerCase().replace(/_/g,"-");
      var code=raw.split("-")[0];
      if(code==="zh")code=raw.indexOf("tw")>=0||raw.indexOf("hk")>=0?"zh-TW":"zh-CN";
      if(code==="pt")code="pt";
      if(code==="en")return "en";
      return code;
    }
    return "en";
  }
  function getSavedLanguage(){
    try{return localStorage.getItem(STORAGE_KEY)||"";}catch(_){return "";}
  }
  var target=getSavedLanguage()||getBrowserLanguage();
  var started=false;
  function addPicker(){
    var header=document.querySelector("header");
    if(!header||document.getElementById("icha-language-picker"))return;
    var wrap=document.createElement("label");
    wrap.id="icha-language-picker";
    wrap.style.cssText="display:inline-flex;align-items:center;gap:7px;margin:8px 0 8px auto;color:#c5d0e2;font:13px system-ui,sans-serif;white-space:nowrap";
    wrap.appendChild(document.createTextNode("Language"));
    var select=document.createElement("select");
    select.id="icha-language-select";
    select.setAttribute("aria-label","Choose website language");
    select.style.cssText="max-width:150px;min-height:40px;padding:7px 10px;border-radius:9px;border:1px solid #ffffff35;background:#111827;color:#fff;font:inherit";
    select.innerHTML='<option value="en">English</option>';
    wrap.appendChild(select);
    header.appendChild(wrap);
    var hidden=document.createElement("div");
    hidden.id="google_translate_element";
    hidden.style.cssText="position:absolute!important;left:-9999px!important;top:-9999px!important";
    document.body.appendChild(hidden);
  }
  function apply(code,save){
    var native=document.querySelector(".goog-te-combo");
    code=code||"en";
    if(native){
      native.value=code==="en"?"":code;
      native.dispatchEvent(new Event("change",{bubbles:true}));
    }
    document.documentElement.lang=code;
    target=code;
    if(save){try{localStorage.setItem(STORAGE_KEY,code);}catch(_){}}
  }
  function fillPicker(){
    var native=document.querySelector(".goog-te-combo");
    var picker=document.getElementById("icha-language-select");
    if(!native||!picker)return false;
    if(!picker.dataset.ready){
      Array.prototype.forEach.call(native.options,function(opt){
        if(!opt.value||picker.querySelector('option[value="'+opt.value.replace(/"/g,'\\"')+'"]'))return;
        var copy=document.createElement("option");
        copy.value=opt.value;copy.textContent=opt.textContent;
        picker.appendChild(copy);
      });
      picker.dataset.ready="1";
      picker.addEventListener("change",function(){apply(picker.value||"en",true);});
    }
    var available=Array.prototype.some.call(picker.options,function(o){return o.value===target;});
    var desired=available?target:"en";
    picker.value=desired;
    if(target!==desired)target=desired;
    if(desired!=="en"&&!picker.dataset.initialApplied){
      picker.dataset.initialApplied="1";
      apply(desired,false);
    }
    return true;
  }
  window.googleTranslateElementInit=function(){
    if(started)return;started=true;
    try{new google.translate.TranslateElement({pageLanguage:"en",autoDisplay:false}, "google_translate_element");}catch(_){}
    var tries=0;
    var timer=setInterval(function(){
      tries++;
      if(fillPicker()||tries>80)clearInterval(timer);
    },250);
  };
  var css=document.createElement("style");
  css.textContent=".goog-te-banner-frame,.goog-te-balloon-frame{display:none!important}body{top:0!important}.skiptranslate{max-width:100%}#icha-language-picker{z-index:5}";
  document.head.appendChild(css);
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",addPicker);else addPicker();
  var script=document.createElement("script");
  script.src="https://translate.google.com/translate_a/element.js?cb=googleTranslateElementInit";
  script.async=true;
  script.onerror=function(){var p=document.getElementById("icha-language-select");if(p){p.innerHTML='<option value="en">English</option>';p.value="en";}};
  document.head.appendChild(script);
})();