import { auth } from "../api.ts";
import { browsePath, getSavedSource, router } from "../App.bub.js";

var Login = {
  name: "Login",

  template() {
    return /*html*/`
      <div class="min-h-screen flex items-center justify-center bg-gray-50 p-4">
        <div class="w-full max-w-sm">
          <div class="bg-white rounded-xl shadow-md p-6">
            <div class="flex items-center gap-2 mb-6">
              <span class="material-icons text-blue-600 text-3xl">menu_book</span>
              <h1 class="text-2xl font-bold">{{ t('MangaYomu') }}</h1>
            </div>

            <p class="mb-3 text-sm text-gray-500">{{ t('Sign in to an account saved only in this browser or device.') }}</p>
            <p class="text-red-500 text-sm mb-3" x-show="error">{{ t(error) }}</p>

            <div class="space-y-3">
              <input ref="emailInput"
                type="email" :placeholder="t('Email')"
                class="w-full border rounded-lg px-3 py-2.5 text-sm"
                @keydown="onKeydown" />
              <input ref="passInput"
                type="password" :placeholder="t('Password (minimum 4 characters)')"
                class="w-full border rounded-lg px-3 py-2.5 text-sm"
                @keydown="onKeydown" />
              <button @click="doLogin"
                class="w-full bg-blue-600 text-white py-2.5 rounded-lg hover:bg-blue-700 font-medium">
                {{ t('Sign in') }}
              </button>
            </div>

            <p class="text-sm text-gray-500 text-center mt-4">
              {{ t('Need a client account?') }}
              <a href="#/signup" class="text-blue-600 hover:underline">{{ t('Create one') }}</a>
            </p>
          </div>
        </div>
      </div>
    `;
  },

  data() {
    return {
      error: "",
    };
  },

  onKeydown(e) {
    if (e.key === "Enter") this.doLogin();
  },

  async doLogin() {
    var email = this.refs.emailInput.value.trim();
    var pass = this.refs.passInput.value;
    if (!email || !pass) {
      this.data.error.value = "Enter your email and password";
      return;
    }
    this.data.error.value = "";
    try {
      var result = await auth.login(email, pass);
      auth.saveToken(result.token);
      router.navigate(browsePath(getSavedSource()));
    } catch (err) {
      this.data.error.value = err.message;
    }
  },
};

export default Login;
