/*
 * Copyright (c) 2008-2016 the original author or authors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package org.cometd.oort;

import javax.servlet.ServletConfig;
import javax.servlet.ServletContext;
import javax.servlet.ServletException;
import javax.servlet.UnavailableException;
import javax.servlet.http.HttpServlet;

import org.cometd.bayeux.server.BayeuxServer;
import org.cometd.common.JSONContext;

/**
 * <p>This servlet serves as a base class for initializing and configuring an
 * instance of the {@link Oort} CometD cluster manager.</p>
 * <p>The following servlet init parameters are used to configure the Oort instance:</p>
 * <ul>
 * <li><code>oort.url</code>, the absolute public URL to the CometD servlet</li>
 * <li><code>oort.secret</code>, the pre-shared secret that Oort servers use to authenticate
 * connections from other Oort comets</li>
 * <li><code>oort.channels</code>, a comma separated list of channels that
 * will be passed to {@link Oort#observeChannel(String)}</li>
 * <li><code>clientDebug</code>, a boolean that enables debugging of the
 * clients connected to other oort cluster managers</li>
 * </ul>
 * <p>Override method {@link #newOort(BayeuxServer, String)} to return a customized
 * instance of {@link Oort}.</p>
 *
 * @see SetiServlet
 */
public abstract class OortConfigServlet extends HttpServlet
{
    public static final String OORT_URL_PARAM = "oort.url";
    public static final String OORT_SECRET_PARAM = "oort.secret";
    public static final String OORT_CHANNELS_PARAM = "oort.channels";
    public static final String OORT_ENABLE_ACK_EXTENSION_PARAM = "enableAckExtension";
    public static final String OORT_JSON_CONTEXT_PARAM = "jsonContext";

    public void init(ServletConfig config) throws ServletException
    {
        super.init(config);

        ServletContext servletContext = config.getServletContext();
        BayeuxServer bayeux = (BayeuxServer)servletContext.getAttribute(BayeuxServer.ATTRIBUTE);
        if (bayeux == null)
            throw new UnavailableException("Missing " + BayeuxServer.ATTRIBUTE + " attribute");

        String url = provideOortURL();
        if (url == null)
            throw new UnavailableException("Missing " + OORT_URL_PARAM + " init parameter");

        try
        {
            Oort oort = newOort(bayeux, url);

            String secret = config.getInitParameter(OORT_SECRET_PARAM);
            if (secret != null)
                oort.setSecret(secret);

            boolean enableAckExtension = Boolean.parseBoolean(config.getInitParameter(OORT_ENABLE_ACK_EXTENSION_PARAM));
            oort.setAckExtensionEnabled(enableAckExtension);

            String jsonContext = config.getInitParameter(OORT_JSON_CONTEXT_PARAM);
            if (jsonContext != null)
                oort.setJSONContextClient((JSONContext.Client)getClass().getClassLoader().loadClass(jsonContext).newInstance());

            oort.start();
            servletContext.setAttribute(Oort.OORT_ATTRIBUTE, oort);

            configureCloud(config, oort);

            String channels = config.getInitParameter(OORT_CHANNELS_PARAM);
            if (channels != null)
            {
                String[] patterns = channels.split(",");
                for (String channel : patterns)
                {
                    channel = channel.trim();
                    if (channel.length() > 0)
                        oort.observeChannel(channel);
                }
            }
        }
        catch (Exception x)
        {
            throw new ServletException(x);
        }
    }

    /**
     * <p>Retrieves the {@code oort.url} parameter from this servlet init parameters.</p>
     * <p>Subclasses can override this method to compute the {@code oort.url} parameter
     * dynamically, for example by retrieving the IP address of the host.</p>
     *
     * @return the {@code oort.url} parameter
     */
    protected String provideOortURL()
    {
        return getServletConfig().getInitParameter(OORT_URL_PARAM);
    }

    /**
     * <p>Configures the Oort cloud by establishing connections with other Oort comets.</p>
     * <p>Subclasses implement their own strategy to discover and link with other comets.</p>
     *
     * @param config the servlet configuration to read parameters from
     * @param oort the Oort instance associated with this configuration servlet
     * @throws Exception if the cloud configuration fails
     */
    protected abstract void configureCloud(ServletConfig config, Oort oort) throws Exception;

    /**
     * <p>Creates and returns a new Oort instance.</p>
     *
     * @param bayeux the BayeuxServer instance to which the Oort instance should be associated to
     * @param url the {@code oort.url} of the Oort instance
     * @return a new Oort instance
     */
    protected Oort newOort(BayeuxServer bayeux, String url)
    {
        return new Oort(bayeux, url);
    }

    public void destroy()
    {
        try
        {
            ServletContext servletContext = getServletConfig().getServletContext();
            Oort oort = (Oort)servletContext.getAttribute(Oort.OORT_ATTRIBUTE);
            servletContext.removeAttribute(Oort.OORT_ATTRIBUTE);
            if (oort != null)
                oort.stop();
        }
        catch (Exception x)
        {
            throw new RuntimeException(x);
        }
    }
}
